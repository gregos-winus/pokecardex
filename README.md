# PokéScan

Application web qui reconnaît les cartes Pokémon avec la webcam ou l'appareil photo du téléphone.
Tout s'exécute dans le navigateur : pas de serveur, pas de clé d'API.

**En ligne : https://gregos-winus.github.io/pokecardex/**

## Fonctionnement

1. **Cadrage** : l'application cherche les 4 bords de la carte, avec des droites détectées par une
   transformée de Hough et plusieurs règles (format d'une carte, bords bien visibles, rectangle le plus extérieur).
   Elle redresse ensuite la perspective. Une carte posée de biais ou photographiée en angle est donc lue correctement.
   En mode photo, la carte est trouvée automatiquement dans l'image. Si les bords ne sont pas trouvés, on prend le contenu du cadre.
2. **Lecture (OCR)** : [Tesseract.js](https://tesseract.projectnaptha.com/) lit le **nom** (en haut) et le **numéro** (en bas, ex. `025/198`).
   Si le nom n'est pas trouvé, la lecture est relancée avec d'autres réglages : image brute, puis texte clair sur fond sombre.
   Si c'est encore insuffisant, on essaie un autre cadrage.
3. **Rapprochement** : le texte lu est comparé à toute la base [TCGdex](https://tcgdex.dev) (FR, EN, DE, ES, IT, PT).
   La comparaison tolère les fautes de lecture. Le numéro et le total du set permettent de trouver l'édition exacte.
4. **Scan automatique (vidéo)** : chaque lecture part de l'image la plus nette parmi plusieurs images rapprochées,
   ce qui limite l'effet du tremblement de la main et de la mise au point. Les lectures successives votent pour
   les cartes candidates, et une lecture ratée ne remet pas tout à zéro. D'une image à l'autre, l'application
   essaie aussi d'autres cadrages et d'autres réglages d'OCR. La carte est retenue quand les indices suffisent :
   en général 1 à 3 lectures.
5. **Vérification visuelle** : quand plusieurs cartes portent le même nom, l'image capturée est comparée aux
   images officielles pour choisir la bonne illustration.

On obtient ensuite la fiche de la carte (set, rareté, illustrateur, prix Cardmarket s'il est connu) et on peut
l'ajouter à sa collection, gardée dans le navigateur et exportable en CSV.

## Lancer l'application

Ce sont des fichiers statiques. Il suffit de les servir en HTTP. Ouvrir `index.html` directement
(`file://`) ne marche pas, à cause des modules JavaScript.

```bash
cd pokecardex
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```

### Sur le téléphone

Les navigateurs n'ouvrent la caméra en direct que sur une page **HTTPS** (ou sur `localhost`).
Pour l'utiliser depuis le téléphone, il faut héberger le dossier sur un site HTTPS gratuit, par exemple :

- **GitHub Pages** : pousser le dossier dans un dépôt, puis Settings → Pages ;
- **Netlify Drop** (https://app.netlify.com/drop) : glisser-déposer le dossier ;
- **Cloudflare Pages** ou **Vercel**.

Sans HTTPS, le bouton **📷 Photo** marche quand même : il ouvre l'appareil photo natif du téléphone.

Sur le téléphone, on peut ensuite choisir « Ajouter à l'écran d'accueil » pour l'utiliser comme une application.

## Conseils pour une bonne reconnaissance

- Tenir le téléphone à **15–20 cm** de la carte : plus près, beaucoup d'appareils photo ne font plus la mise au point.
- Carte à plat, bien éclairée, sans reflet (les cartes holo reflètent beaucoup, inclinez légèrement la lumière).
- Remplir le cadre : le **nom** doit être dans la zone pointillée du haut, le **numéro** dans celle du bas.
- Sur téléphone, la lampe (🔦) aide à lire le petit numéro.
- Choisir la bonne **langue** en haut à droite (celle de la carte).
- Le mode **Auto** analyse en continu jusqu'à trouver la carte.
- « Détails de la lecture » montre ce que l'OCR a lu, ce qui aide si la carte n'est pas reconnue.
- En cas d'échec, la recherche par nom reste disponible.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | Interface |
| `app.js` | Caméra, mode photo (glisser / zoomer), scan auto, affichage, collection |
| `ocr.js` | Lecture des zones nom / numéro avec Tesseract.js |
| `matcher.js` | Normalisation, distance de Levenshtein, index des cartes, score des candidats |
| `vision.js` | Détection des bords de la carte, redressement de perspective, prétraitement, signatures visuelles |
| `tcgdex.js` | Accès à l'API TCGdex, avec cache local de 3 jours |

## Limites

- Les cartes japonaises et coréennes ne sont pas prises en charge.
- Les suffixes stylisés (EX, GX, V, VMAX…) sont souvent mal lus. Sans le numéro, l'édition trouvée peut être
  la version sans suffixe du même Pokémon : choisissez la bonne carte dans « Autres possibilités ».
- Les numéros spéciaux (`TG05/TG30`, `SWSH050`…) ne sont pas lus. La carte est alors trouvée par son nom et son illustration.
- Les prix viennent de TCGdex quand ils existent. Ce sont des indications.
- Le premier lancement télécharge la base de cartes (quelques Mo) et le modèle OCR (quelques Mo).
  Les lancements suivants utilisent le cache.
