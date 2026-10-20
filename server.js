'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const QUESTION_MS = 30_000;
const GRACE_MS = 400;            // laisse arriver les derniers brouillons avant de clore la question
const MIN_Q = 10;
const MAX_Q = 20;
const HOST_TRANSFER_MS = 20_000; // si l'hôte disparaît, un autre joueur reprend la main
const ROOM_TTL_MS = 30 * 60_000; // salle vide supprimée après 30 min

const THEMES = [
  'Histoire', 'Musique', 'Philosophie', 'Littérature', 'Mythologie grecque',
  'Art', 'Cinéma', 'Géographie', 'Manga', 'Culture générale',
];
const DIFFICULTIES = ['Facile', 'Moyen', 'Difficile'];
const MIXED = 'Mélangé';

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const REPORT_FILE = path.join(__dirname, 'signalements.txt');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const rooms = new Map();

// ---------------------------------------------------------------- Questions

// Relu à chaque partie : on peut modifier questions.json sans redémarrer.
function loadQuestions() {
  try {
    const raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
    return raw
      .filter(q => Array.isArray(q) && q.length >= 3)
      .map(([theme, text, answer, difficulty]) => ({
        theme: String(theme).trim(),
        text: String(text).trim(),
        answer: String(answer).trim(),
        // Sans 4e élément, la question est rangée en « Moyen ».
        difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : 'Moyen',
      }))
      .filter(q => q.theme && q.text && q.answer);
  } catch (e) {
    console.error('Impossible de lire questions.json :', e.message);
    return [];
  }
}

// Nombre de questions par thème et par difficulté, pour le salon.
function themeCounts() {
  const empty = () => Object.fromEntries(DIFFICULTIES.map(d => [d, 0]));
  const counts = new Map(THEMES.map(t => [t, empty()]));
  for (const q of loadQuestions()) {
    if (!counts.has(q.theme)) counts.set(q.theme, empty());
    counts.get(q.theme)[q.difficulty]++;
  }
  return [...counts].map(([name, byDifficulty]) => ({ name, byDifficulty }));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tirage équilibré : on pioche à tour de rôle dans chaque thème, puis on mélange.
function draw(pool, themes, difficulty, count) {
  const byTheme = new Map();
  const seen = new Set();
  for (const q of shuffle(pool)) {
    if (!themes.includes(q.theme)) continue;
    if (difficulty !== MIXED && q.difficulty !== difficulty) continue;
    const key = q.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byTheme.has(q.theme)) byTheme.set(q.theme, []);
    byTheme.get(q.theme).push(q);
  }
  const lists = shuffle([...byTheme.values()]);
  const out = [];
  while (out.length < count && lists.some(l => l.length)) {
    for (const l of lists) {
      if (out.length >= count) break;
      if (l.length) out.push(l.pop());
    }
  }
  return shuffle(out);
}

// ---------------------------------------------------------------- Salles

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O pour éviter les confusions
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: new Map(),
    phase: 'lobby',
    game: null,
    lastActivity: Date.now(),
    hostTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let i = 2;
  while (taken.has(`${name} (${i})`.toLowerCase())) i++;
  return `${name} (${i})`;
}

function addPlayer(room, name, ws) {
  const player = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name: uniqueName(room, name),
    ws: null,
    connected: false,
  };
  room.players.set(player.id, player);
  attach(room, player, ws);
  return player;
}

function attach(room, player, ws) {
  if (player.ws && player.ws !== ws) {
    try { player.ws.close(); } catch {}
  }
  player.ws = ws;
  player.connected = true;
  ws.ctx = { room, player };
  send(ws, { type: 'joined', code: room.code, token: player.token, name: player.name });
}

function score(room, playerId) {
  const g = room.game;
  if (!g) return 0;
  return g.grades.reduce((sum, grades) => sum + (grades[playerId] || 0), 0);
}

function snapshot(room, viewer, themes) {
  const g = room.game;
  const s = {
    type: 'state',
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: viewer.id,
    gameId: g ? g.id : null,
    difficulty: g ? g.difficulty : null,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: score(room, p.id),
      answered: room.phase === 'question' && p.id in g.answers[g.index],
    })),
  };

  if (room.phase === 'lobby') {
    s.themes = themes;
    s.difficulties = DIFFICULTIES;
    s.minQ = MIN_Q;
    s.maxQ = MAX_Q;
  }

  if (room.phase === 'question') {
    const q = g.questions[g.index];
    // Jamais la bonne réponse ni les réponses des autres pendant la phase 1.
    s.question = {
      index: g.index,
      total: g.questions.length,
      theme: q.theme,
      text: q.text,
      remainingMs: Math.max(0, g.deadline - Date.now()),
      yourAnswer: g.answers[g.index][viewer.id] ?? null,
      playing: g.participants.includes(viewer.id),
    };
  }

  if (room.phase === 'review') {
    const q = g.questions[g.reviewIndex];
    s.review = {
      index: g.reviewIndex,
      total: g.questions.length,
      theme: q.theme,
      text: q.text,
      answer: q.answer,
      cursor: g.cursor,
      entries: g.participants.map(id => ({
        playerId: id,
        name: room.players.get(id)?.name ?? '?',
        answer: g.answers[g.reviewIndex][id] ?? '',
        grade: g.grades[g.reviewIndex][id] ?? null,
      })),
    };
  }

  if (room.phase === 'end') s.total = g.questions.length;
  return s;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  const themes = room.phase === 'lobby' ? themeCounts() : null;
  for (const p of room.players.values()) {
    if (p.connected) send(p.ws, snapshot(room, p, themes));
  }
}

// ---------------------------------------------------------------- Partie

function startGame(room, themes, difficulty, count) {
  const questions = draw(loadQuestions(), themes, difficulty, count);
  if (!questions.length) return 'Aucune question disponible pour ces thèmes à ce niveau.';
  room.game = {
    id: crypto.randomBytes(4).toString('hex'),
    difficulty,
    questions,
    participants: [...room.players.keys()],
    index: -1,
    deadline: 0,
    timer: null,
    answers: questions.map(() => ({})),
    drafts: {},
    grades: questions.map(() => ({})),
    reviewIndex: 0,
    cursor: 0,
    reported: new Set(),
  };
  room.phase = 'question';
  nextQuestion(room);
  return questions.length < count
    ? `Seulement ${questions.length} questions disponibles pour ces thèmes à ce niveau.`
    : null;
}

function nextQuestion(room) {
  const g = room.game;
  clearTimeout(g.timer);
  g.index++;
  g.drafts = {};
  if (g.index >= g.questions.length) return startReview(room);
  g.deadline = Date.now() + QUESTION_MS;
  g.timer = setTimeout(() => endQuestion(room), QUESTION_MS + GRACE_MS);
  broadcast(room);
}

// Fin du chrono : ce qui était tapé sans être validé compte quand même.
function endQuestion(room) {
  const g = room.game;
  if (!g || room.phase !== 'question') return;
  const answers = g.answers[g.index];
  for (const [id, text] of Object.entries(g.drafts)) {
    if (!(id in answers) && text) answers[id] = text;
  }
  nextQuestion(room);
}

function everyoneAnswered(room) {
  const g = room.game;
  const answers = g.answers[g.index];
  const active = g.participants.filter(id => room.players.get(id)?.connected);
  return active.length > 0 && active.every(id => id in answers);
}

function startReview(room) {
  const g = room.game;
  clearTimeout(g.timer);
  room.phase = 'review';
  g.reviewIndex = 0;
  g.cursor = 0;
  // Pas de réponse = incorrect d'office ; le reste attend la décision de l'hôte.
  g.answers.forEach((answers, qi) => {
    for (const id of g.participants) if (!answers[id]) g.grades[qi][id] = 0;
  });
  broadcast(room);
}

function report(room, player, index) {
  const g = room.game;
  const q = g.questions[index];
  const key = `${index}:${player.id}`;
  if (g.reported.has(key)) return;
  g.reported.add(key);
  const line = [
    new Date().toLocaleString('fr-FR'),
    `salle ${room.code}`,
    `signalé par ${player.name}`,
    `${q.theme} (${q.difficulty})`,
    q.text,
    `réponse attendue : ${q.answer}`,
  ].join(' | ');
  console.log('[SIGNALEMENT] ' + line); // visible dans les logs de l'hébergeur
  fs.appendFile(REPORT_FILE, line + '\n', 'utf8', err => {
    if (err) console.error("Impossible d'écrire dans signalements.txt :", err.message);
  });
  send(player.ws, { type: 'toast', message: 'Question signalée, merci !' });
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- Messages

function handle(ws, msg) {
  if (msg.type === 'create') {
    const name = cleanText(msg.name, 20);
    if (!name) return send(ws, { type: 'error', message: 'Choisis un pseudo.' });
    const room = createRoom();
    const p = addPlayer(room, name, ws);
    room.hostId = p.id;
    return broadcast(room);
  }

  if (msg.type === 'join') {
    const room = rooms.get(cleanText(msg.code, 4).toUpperCase());
    if (!room) return send(ws, { type: 'error', fatal: true, message: 'Salle introuvable.' });
    room.lastActivity = Date.now();

    const existing = msg.token && [...room.players.values()].find(p => p.token === msg.token);
    if (existing) {
      attach(room, existing, ws);
      if (existing.id === room.hostId) clearTimeout(room.hostTimer);
      return broadcast(room);
    }
    if (room.phase !== 'lobby') {
      return send(ws, { type: 'error', fatal: true, message: 'La partie a déjà commencé dans cette salle.' });
    }
    const name = cleanText(msg.name, 20);
    if (!name) return send(ws, { type: 'error', message: 'Choisis un pseudo.' });
    addPlayer(room, name, ws);
    return broadcast(room);
  }

  if (!ws.ctx) return;
  const { room, player } = ws.ctx;
  const g = room.game;
  const isHost = player.id === room.hostId;
  room.lastActivity = Date.now();

  switch (msg.type) {
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      const themes = (Array.isArray(msg.themes) ? msg.themes : []).map(String);
      if (!themes.length) return send(ws, { type: 'error', message: 'Choisis au moins un thème.' });
      const count = clamp(parseInt(msg.count, 10) || MIN_Q, MIN_Q, MAX_Q);
      const difficulty = [...DIFFICULTIES, MIXED].includes(msg.difficulty) ? msg.difficulty : 'Moyen';
      const warning = startGame(room, themes, difficulty, count);
      if (warning) send(ws, { type: room.phase === 'lobby' ? 'error' : 'toast', message: warning });
      return;
    }

    case 'draft':
    case 'answer': {
      if (room.phase !== 'question' || msg.index !== g.index) return;
      if (!g.participants.includes(player.id) || player.id in g.answers[g.index]) return;
      const text = cleanText(msg.text, 200);
      if (msg.type === 'draft') {
        g.drafts[player.id] = text;
        return;
      }
      if (!text) return;
      g.answers[g.index][player.id] = text;
      return everyoneAnswered(room) ? endQuestion(room) : broadcast(room);
    }

    case 'grade': {
      if (!isHost || room.phase !== 'review') return;
      const qi = msg.index;
      if (!Number.isInteger(qi) || qi < 0 || qi >= g.questions.length) return;
      if (!g.participants.includes(msg.playerId)) return;
      if (![1, 0.5, 0, null].includes(msg.value)) return;
      if (msg.value === null) delete g.grades[qi][msg.playerId];
      else g.grades[qi][msg.playerId] = msg.value;
      return broadcast(room);
    }

    case 'nav': {
      if (!isHost || room.phase !== 'review') return;
      g.reviewIndex = clamp(parseInt(msg.index, 10) || 0, 0, g.questions.length - 1);
      g.cursor = clamp(parseInt(msg.cursor, 10) || 0, 0, Math.max(0, g.participants.length - 1));
      return broadcast(room);
    }

    case 'finish':
      if (!isHost || room.phase !== 'review') return;
      room.phase = 'end';
      return broadcast(room);

    case 'back':
      if (!isHost || room.phase !== 'end') return;
      room.phase = 'review';
      return broadcast(room);

    case 'restart':
      if (!isHost || room.phase !== 'end') return;
      room.phase = 'lobby';
      room.game = null;
      for (const p of room.players.values()) {
        if (!p.connected && p.id !== room.hostId) room.players.delete(p.id);
      }
      return broadcast(room);

    // Le joueur revient à l'accueil : il quitte la salle tout de suite.
    case 'leave': {
      ws.ctx = null;
      player.ws = null;
      player.connected = false;
      if (room.phase === 'lobby') room.players.delete(player.id);
      if (isHost) {
        clearTimeout(room.hostTimer);
        const next = [...room.players.values()].find(p => p.connected);
        if (next) {
          room.hostId = next.id;
          send(next.ws, { type: 'toast', message: "L'hôte est parti : c'est toi qui mènes la partie." });
        }
      }
      if (room.phase === 'question' && everyoneAnswered(room)) return endQuestion(room);
      return broadcast(room);
    }

    case 'report': {
      if (!g || room.phase === 'lobby') return;
      const max = room.phase === 'question' ? g.index : g.questions.length - 1;
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index > max) return;
      return report(room, player, msg.index);
    }
  }
}

function onClose(ws) {
  if (!ws.ctx) return;
  const { room, player } = ws.ctx;
  if (player.ws !== ws) return; // remplacé par une reconnexion
  player.ws = null;
  player.connected = false;
  room.lastActivity = Date.now();

  if (room.phase === 'lobby' && player.id !== room.hostId) {
    room.players.delete(player.id);
  }

  if (player.id === room.hostId) {
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      const host = room.players.get(room.hostId);
      if (host && host.connected) return;
      const next = [...room.players.values()].find(p => p.connected);
      if (!next) return;
      room.hostId = next.id;
      send(next.ws, { type: 'toast', message: "L'hôte est parti : c'est toi qui mènes la partie." });
      broadcast(room);
    }, HOST_TRANSFER_MS);
  }

  if (room.phase === 'question' && everyoneAnswered(room)) return endQuestion(room);
  broadcast(room);
}

// ---------------------------------------------------------------- Serveur

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/signalements') {
    return fs.readFile(REPORT_FILE, 'utf8', (err, data) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err ? 'Aucun signalement pour le moment.' : data);
    });
  }
  if (url !== '/' && url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Introuvable');
  }
  fs.readFile(INDEX_FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Erreur : public/index.html introuvable');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg.type === 'string') handle(ws, msg);
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// Ping régulier : détecte les connexions mortes et évite les coupures pour inactivité du tunnel.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

// Ménage des salles abandonnées.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = ![...room.players.values()].some(p => p.connected);
    if (empty && now - room.lastActivity > ROOM_TTL_MS) {
      if (room.game) clearTimeout(room.game.timer);
      clearTimeout(room.hostTimer);
      rooms.delete(room.code);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`KoleBallRun lancé sur http://localhost:${PORT}`);
  console.log(`Pour inviter des amis : cloudflared tunnel --url http://localhost:${PORT}`);
});
