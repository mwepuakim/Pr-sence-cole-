# Presence des enseignants par empreinte digitale

Ce projet connecte une pointeuse biometrique (ZKTeco ou compatible eSSL/Anviz, protocole
ADMS / iClock) a un tableau de bord web que la direction consulte depuis n'importe quel
telephone, sans rien installer.

Comment ca marche :
1. Chaque enseignant pose son doigt sur la pointeuse physique installee a l'entree.
2. La pointeuse envoie automatiquement le pointage a ce serveur, via internet.
3. Le serveur enregistre le pointage et calcule le statut (present / retard / absent).
4. La direction ouvre le tableau de bord dans son navigateur (et peut l'ajouter a
   l'ecran d'accueil de son iPhone pour qu'il s'ouvre comme une app).

Aucune installation de Flutter, Xcode, ordinateur ou autre outil de developpement n'est
necessaire. Tout ce guide se fait depuis Safari sur votre iPhone. Le projet tient en
deux fichiers seulement (`server.js` et `package.json`), justement pour que l'envoi
vers GitHub reste simple depuis un telephone (pas de dossiers imbriques a gerer).

---

## Etape 1 - Choisir et acheter la pointeuse

Cherchez un modele qui :
- fait de la reconnaissance d'empreinte (pas seulement badge/carte)
- a une connexion Ethernet ou WiFi (pas seulement USB) : indispensable pour envoyer les
  donnees au serveur automatiquement
- supporte le mode **ADMS / cloud push / iClock** (c'est le cas de la plupart des
  ZKTeco recents, et des marques compatibles eSSL, Anviz). Demandez confirmation au
  vendeur si ce n'est pas precise dans la fiche produit.

Pour 30 a 100 enseignants, un modele d'entree ou milieu de gamme suffit largement (la
plupart stockent au minimum 1000 a 3000 empreintes). Comptez environ 300 a 800 euros
selon le modele et les fonctionnalites (ecran couleur, WiFi, etc.).

---

## Etape 2 - Mettre le code en ligne sur GitHub, depuis votre iPhone

### 2.1 Recuperer les fichiers sur votre iPhone

1. Telechargez le fichier `ecole-presence.zip` que je vous ai donne (appuyez dessus
   dans la conversation, puis en haut a droite pour le sauvegarder). Il atterrit
   dans **Fichiers > Telechargements** (ou "Sur mon iPhone").
2. Ouvrez l'app **Fichiers**, trouvez `ecole-presence.zip`, appuyez dessus une fois :
   iOS l'extrait automatiquement dans un dossier `ecole-presence`.

### 2.2 Creer le repository GitHub

1. Ouvrez [github.com](https://github.com) dans Safari, creez un compte gratuit si
   necessaire.
2. Appuyez sur **+** puis **New repository**.
3. Nommez-le par exemple `ecole-presence`, laissez-le prive si vous preferez, puis
   **Create repository**.

### 2.3 Envoyer les fichiers (sans glisser-deposer)

1. Sur la page du repository, appuyez sur **Add file > Upload files**.
2. Appuyez sur la zone d'upload : elle ouvre le selecteur de fichiers de l'iPhone.
3. Naviguez jusqu'au dossier `ecole-presence` extrait a l'etape 2.1.
4. Appuyez sur **Selectionner** (en haut a droite), puis touchez `server.js` et
   `package.json` pour les cocher tous les deux (vous pouvez aussi ajouter
   `README.md` et `.gitignore` si vous voulez, ce n'est pas obligatoire pour que
   l'app fonctionne).
5. Validez, puis appuyez sur **Commit changes** en bas de la page.

Comme il n'y a que deux fichiers, sans sous-dossiers, la selection depuis l'iPhone
fonctionne directement (pas besoin de glisser-deposer un dossier entier, ce qui ne
marche pas sur mobile).

---

## Etape 3 - Deployer le serveur sur Render (gratuit pour commencer)

1. Creez un compte sur [render.com](https://render.com) (vous pouvez vous connecter
   directement avec votre compte GitHub).
2. Cliquez sur **New > Web Service**.
3. Choisissez votre repository `ecole-presence`.
4. Render detecte automatiquement Node.js. Verifiez :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
5. Dans la section **Environment**, ajoutez ces variables (voir aussi `.env.example`) :
   - `ADMIN_PASSWORD` : le mot de passe que vous utiliserez pour vous connecter au
     tableau de bord
   - `SESSION_SECRET` : une longue chaine de caracteres aleatoires (n'importe quoi
     d'assez long et impossible a deviner)
   - `SCHOOL_START` : l'heure de debut des cours, ex `08:00`
   - `LATE_GRACE_MINUTES` : la tolerance de retard en minutes, ex `15`
6. Cliquez sur **Create Web Service**. Le deploiement prend 1 a 2 minutes.
7. Une fois pret, Render vous donne une adresse du type
   `https://ecole-presence.onrender.com`. C'est l'adresse de votre application.

### Limites importantes du plan gratuit Render

- **Le disque est efface a chaque nouveau deploiement** (chaque fois que vous
  modifiez le code et le renvoyez sur GitHub). Les pointages et enseignants
  enregistres entre-temps seraient perdus. Pour un usage reel et durable, il faudra
  passer a un disque persistant (quelques dollars/mois sur Render) une fois le
  systeme teste et valide.
- **Le service s'endort apres 15 minutes d'inactivite** et met 30 a 60 secondes a se
  reveiller au prochain appel. Si la pointeuse pousse un pointage pendant que le
  serveur dort, ce pointage peut echouer selon le delai d'attente de la pointeuse.
  Pour un usage en production (pas juste un test), le plan payant le moins cher
  (~7 $/mois) qui reste toujours actif est fortement recommande.

---

## Etape 4 - Configurer la pointeuse

Sur le menu de la pointeuse (generalement **Communication > Configuration
Cloud / ADMS Serveur** ou equivalent selon le modele) :
- **Adresse du serveur** : `ecole-presence.onrender.com` (sans le `https://`)
- **Port** : `443`
- **Activer HTTPS / SSL** : oui si l'option existe
- Activez l'option ADMS / Cloud push

L'appareil doit ensuite se connecter tout seul. Le tableau de bord affichera un point
vert "Pointeuse en ligne" une fois le premier contact etabli.

---

## Etape 5 - Ajouter les enseignants et enregistrer leurs empreintes

Il y a deux endroits a renseigner, avec le **meme numero (PIN)** dans les deux :

1. **Dans le tableau de bord** (ouvrez votre URL Render, connectez-vous avec
   `ADMIN_PASSWORD`) : section "Gerer les enseignants", ajoutez le PIN, le nom, le
   role (direction / surveillant general / secretariat / enseignant) et la matiere.
2. **Sur la pointeuse elle-meme** (directement sur son ecran/clavier) : menu
   "Utilisateurs > Ajouter", entrez le meme PIN, puis suivez les instructions pour
   enregistrer l'empreinte digitale de la personne (generalement 2 a 3 scans du
   meme doigt).

C'est cette correspondance de PIN qui permet au tableau de bord de savoir a qui
appartient chaque pointage.

---

## Etape 6 - Utiliser le tableau de bord comme une app sur iPhone

1. Ouvrez votre URL Render dans Safari sur l'iPhone.
2. Appuyez sur l'icone de partage, puis **Sur l'ecran d'accueil**.
3. Une icone apparait sur l'ecran d'accueil et ouvre le tableau de bord en plein
   ecran, comme une vraie application.

---

## Point legal a ne pas sauter

La collecte d'empreintes digitales est un traitement de donnees biometriques,
encadre par la loi dans la plupart des pays (consentement ecrit des enseignants,
duree de conservation, securite du stockage). Renseignez-vous sur la reglementation
de votre pays avant le deploiement reel (equivalent local du RGPD ou autre).

---

## Ameliorations possibles pour la suite

- Export des rapports en Excel/PDF
- Historique et statistiques par enseignant sur le mois
- Notifications automatiques en cas d'absence
- Gestion de plusieurs pointeuses (plusieurs entrees)
- Vrais comptes utilisateurs par role au lieu d'un seul mot de passe admin

---

## Developper en local (optionnel, si vous installez Node.js plus tard)

```
npm install
cp .env.example .env
npm start
```

Le serveur demarre sur `http://localhost:3000`. Vous pouvez simuler un pointage avec :

```
curl -X POST "http://localhost:3000/iclock/cdata?SN=TEST01&table=ATTLOG" \
  -H "Content-Type: text/plain" \
  --data-binary $'1001\t2026-09-22 07:58:00\t0\t1'
```
