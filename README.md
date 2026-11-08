# Patrimony

Application web locale qui donne de la visibilité sur vos actifs financiers : valeurs en dollars,
cours de marché en temps réel, répartition du portefeuille et simulation d'arbitrages.
Toutes les saisies sont historisées et conservées d'un lancement à l'autre.

## Démarrage

Prérequis : **Python 3.10 ou plus récent**. Aucune bibliothèque à installer. Une connexion
Internet est nécessaire pour les cours.

- Sous Windows : double-cliquez sur `start.bat`.
- Ou, dans un terminal, depuis ce dossier :

  ```
  python server.py
  ```

Le navigateur s'ouvre sur http://127.0.0.1:8000 (ou le port libre suivant). Fermez la fenêtre
du serveur, ou faites Ctrl+C, pour arrêter l'application.

Options utiles :

```
python server.py --port 8080          # autre port
python server.py --no-browser         # ne pas ouvrir le navigateur
python server.py --db D:\patrimoine.db # autre fichier de données
```

## L'écran

**En haut** : le bouton « Actualiser les prix » récupère les cours du moment. L'interrupteur
« Auto » les actualise toutes les 60 secondes tant que l'onglet est visible. « Historique » ouvre
le journal de toutes les saisies. Le dernier bouton bascule entre thème clair et sombre.

**À gauche, « Mes actifs »**

- Le champ de recherche trouve un actif par nom, ticker, lieu ou catégorie. L'actif choisi
  s'affiche en haut, avant le top 5 (« Retirer » le fait disparaître).
- Le top 5 de vos actifs par valeur, avec pour chacun : la valeur en dollars, la quantité,
  la part dans le portefeuille et le lieu de détention, ainsi que le cours et sa variation du jour.
- Un clic sélectionne un actif (bordure bleue). Les boutons Modifier, Historique et Supprimer
  apparaissent sur l'actif sélectionné.
- Le bouton « + Déclarer un actif » se trouve en bas de la liste.

**Au milieu**

- La valeur totale du portefeuille, la plus-value depuis l'achat et la variation du jour.
- Graphique 1 : barre empilée de la répartition selon la **valeur actuelle**.
- Graphique 2 : barre empilée de la répartition selon la **valeur initiale** (prix d'achat).
- Les deux graphiques montrent les 5 premiers actifs et regroupent le reste dans « Autres ».
  Un actif garde la même couleur partout. Survolez un bloc pour le détail, cliquez pour
  sélectionner l'actif. « Afficher le tableau » donne les montants exacts.

**À droite, « Opportunités »**

Si vous vendez l'actif sélectionné, quelle quantité de chacun de vos autres actifs
pourriez-vous obtenir ? Le classement suit les 5 plus grosses positions. Le curseur
« Part vendue » simule une vente partielle. Un même instrument détenu à plusieurs endroits,
par exemple du BTC sur Binance et sur un Ledger, n'apparaît qu'une fois.

## Déclarer un actif

| Type | Pour | Cours |
|---|---|---|
| Bourse & crypto | actions, ETF, fonds, indices, devises, matières premières, cryptos | Yahoo Finance, CoinGecko |
| Liquidités | un solde dans une devise (EUR, USD, CHF…) | taux de change du marché |
| Autre actif | immobilier, parts de société, objet de valeur… | valeur saisie à la main |

La recherche accepte un nom (« LVMH »), un ticker (« MC.PA ») ou un code ISIN. Le prix d'achat
unitaire est prérempli avec le cours du jour : remplacez-le par votre prix réel. Il sert à
calculer la valeur initiale, convertie en dollars au taux de change du jour de la saisie.

## Données et historique

Tout est enregistré dans `data/patrimony.db`, un fichier SQLite créé au premier lancement.

- Chaque déclaration, modification et suppression est ajoutée au journal avec la date et le
  détail « avant → après ». Le journal n'est jamais réécrit, et une suppression retire l'actif
  du portefeuille sans effacer son historique.
- Le dernier cours connu de chaque actif est conservé : les valeurs s'affichent dès le
  lancement, avant même la première actualisation.
- Les cours sont aussi historisés, au plus un point toutes les 5 minutes par instrument et
  seulement quand le cours change.

Pour sauvegarder vos données, copiez le dossier `data` pendant que l'application est arrêtée.

## Cours de marché

- Aucune clé d'API n'est nécessaire.
- Les actions américaines sont en temps réel. La plupart des autres places ont environ
  15 minutes de retard, selon Yahoo Finance. Les cryptos sont mises à jour environ chaque minute.
- Les montants en euros, livres (y compris les cotations en pence), francs suisses, etc.
  sont convertis en dollars au taux du moment, avec Frankfurter (taux BCE) en secours.
- Si un cours ne répond pas, le dernier cours connu reste affiché et l'actif est signalé.
- Pour un usage intensif des cryptos, une clé gratuite « demo » de CoinGecko peut être définie
  dans la variable d'environnement `COINGECKO_API_KEY`.

## Sécurité

Le serveur n'écoute que sur votre ordinateur (127.0.0.1). Il refuse les requêtes venant d'autres
sites web et n'a pas d'authentification : ne l'exposez pas sur un réseau.

## Structure

```
server.py              serveur HTTP (bibliothèque standard Python) et API JSON
patrimony/db.py        schéma SQLite et accès aux données
patrimony/market.py    Yahoo Finance, CoinGecko, taux de change
patrimony/service.py   règles métier : validation, valorisation, actualisation
static/                interface (HTML, CSS, JavaScript sans dépendance)
tests/                 tests automatisés
```

## Tests

```
python -m unittest
```

Les tests n'utilisent pas le réseau : les fournisseurs de cours sont simulés.
