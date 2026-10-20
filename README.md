# KoleBallRun

Quiz multijoueur en réponses libres. Un joueur crée une salle, les autres la rejoignent avec un code de 4 lettres et un pseudo. Hébergement gratuit, sur ton PC ou sur Render.

## Contenu du projet

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur HTTP + WebSocket (paquet `ws`). Les salles vivent en mémoire. |
| `public/index.html` | Le jeu complet (interface + logique client). |
| `questions.json` | La base de questions, format `["Thème", "Question", "Réponse", "Difficulté"]`. |
| `signalements.txt` | Créé automatiquement quand quelqu'un signale une question. Consultable sur la page `/signalements`. |
| `prompt-questions.txt` | Ton prompt pour générer de nouvelles questions. |

## 1. Installer Node.js (une seule fois)

Dans PowerShell :

```
winget install OpenJS.NodeJS.LTS
```

Tu peux aussi le télécharger sur https://nodejs.org (version LTS). **Ferme puis rouvre PowerShell** ensuite, et vérifie avec `node --version`.

## 2. Lancer le jeu

Dans le dossier du projet :

```
npm install
npm start
```

`npm install` n'est à faire qu'une fois. Ouvre ensuite http://localhost:3000 : le jeu marche déjà en local.

Pour tester seul, ouvre deux onglets : chaque onglet compte comme un joueur.

## 3. Inviter tes amis avec Cloudflare Tunnel (gratuit, sans compte)

Cloudflare Tunnel donne une adresse publique en HTTPS qui pointe vers ton PC. Pas besoin d'ouvrir de port sur ta box ni de toucher au pare-feu.

**Installation (une seule fois) :**

```
winget install --id Cloudflare.cloudflared
```

Rouvre PowerShell ensuite.

**À chaque soirée :**

1. Premier terminal : `npm start` (laisse-le ouvert).
2. Second terminal :
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
3. Après quelques secondes, une adresse s'affiche, du type `https://mots-au-hasard.trycloudflare.com`. Envoie-la à tes amis.
4. Dans le salon, le bouton **Copier le lien** donne directement `https://…trycloudflare.com/#CODE`. Le code de la salle est alors prérempli.

À savoir :
- L'adresse change à chaque lancement de `cloudflared`. C'est normal avec un tunnel « rapide ».
- Ton PC doit rester allumé et les deux terminaux ouverts pendant la partie.
- Pour arrêter : `Ctrl+C` dans chaque terminal.

**Option : une adresse fixe.** Il faut un compte Cloudflare (gratuit) et un nom de domaine à toi géré par Cloudflare (le domaine, lui, est payant) :

```
cloudflared tunnel login
cloudflared tunnel create koleballrun
cloudflared tunnel route dns koleballrun quiz.mondomaine.fr
cloudflared tunnel run --url http://localhost:3000 koleballrun
```

Pour un usage entre amis, le tunnel rapide suffit largement.

## Déroulement d'une partie

1. **Salon** : l'hôte (👑) choisit la difficulté (Facile, Moyen, Difficile ou Mélangé), coche les thèmes (un, plusieurs ou tous) et choisit le nombre de questions (10 à 20). Si plusieurs thèmes sont cochés, le tirage est équilibré entre eux. Une question ne sort jamais deux fois dans la même partie.
2. **Phase 1** : chaque question s'affiche avec un chrono de 30 s. Chacun tape sa réponse et valide avec **Entrée**. La question suivante arrive à la fin du chrono, ou plus tôt si tout le monde a validé. À la fin du chrono, une réponse tapée mais pas validée est quand même enregistrée.
3. **Phase 2 (correction)** : les questions repassent une par une, avec la bonne réponse et les réponses de chacun. Commandes de l'hôte :

   | Touche | Action |
   |---|---|
   | `↑` `↓` | choisir une réponse |
   | `C` | correct (1 point) |
   | `P` | presque (0,5 point) |
   | `I` | incorrect (0 point) |
   | `←` `→` | question précédente / suivante |

   Après une note, le curseur passe à la réponse suivante. Une absence de réponse compte d'office comme incorrecte. On peut aussi cliquer sur les boutons C / P / I. Les scores se mettent à jour en direct pour tout le monde.
4. **Classement final**, puis **Nouvelle partie** (on revient au salon avec les mêmes joueurs).

Autres règles :
- Les bonnes réponses ne quittent jamais le serveur avant la phase 2 : même en fouillant dans le navigateur, impossible de tricher.
- **Signaler la question** ajoute une ligne dans `signalements.txt` (date, salle, joueur, thème, question, réponse attendue).
- Si un joueur recharge la page ou perd la connexion, il retrouve sa place automatiquement. Si l'hôte disparaît plus de 20 s, un autre joueur prend la main.
- L'hôte joue aussi. Il corrige donc ses propres réponses : c'est une affaire de confiance entre amis.
- Un clic sur le logo ou le titre KoleBallRun, en haut à gauche, ramène à l'accueil (en quittant la salle).
- Chaque joueur choisit un animal sur l'accueil : chat, chien, fennec, panda roux, hérisson, panda, dauphin, loutre de mer, hippocampe ou tortue. Deux joueurs ne peuvent pas avoir le même tant qu'il en reste de libres. On peut en changer dans le salon (« Changer d'animal »).

## Ajouter des questions

Ajoute des lignes dans `questions.json` :

```json
["Littérature", "Qui est l'auteur des Thibault ?", "Roger Martin du Gard", "Difficile"]
```

- Le thème doit être écrit exactement comme dans la liste : Histoire, Musique, Philosophie, Littérature, Mythologie grecque, Art, Cinéma, Géographie, Manga, Culture générale, Visual Novel, K-pop, Sciences sociales. Un thème nouveau apparaît automatiquement dans le salon.
- La difficulté vaut `Facile`, `Moyen` ou `Difficile`. Sans difficulté, la question est rangée en `Moyen`.
- Le fichier est relu au début de chaque partie : pas besoin de redémarrer le serveur.
- Attention à la syntaxe JSON : une virgule entre chaque ligne, pas de virgule après la dernière. En cas d'erreur, le serveur l'affiche dans le terminal.
- Pour générer des questions en masse, utilise `prompt-questions.txt` avec un assistant IA, puis vérifie les réponses avant de les ajouter.

## Changer le port

```
$env:PORT=8080; npm start
```

Pense alors à mettre `http://localhost:8080` dans la commande `cloudflared`.
