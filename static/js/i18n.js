// Langue de l'interface (français par défaut, anglais en option), mémorisée dans ce navigateur.
// Les données (noms, catégories enregistrées) restent telles quelles ; seul l'affichage est traduit.
import { prefs } from './prefs.js';

const stored = prefs.get('lang', 'fr');
export const LANG = stored === 'en' ? 'en' : 'fr';
export const isEn = LANG === 'en';
export const LOCALE = isEn ? 'en-US' : 'fr-FR';

// Texte selon la langue : t('Actifs', 'Assets').
export const t = (fr, en) => (isEn ? en : fr);

export function setLang(next) {
  prefs.set('lang', next === 'en' ? 'en' : 'fr');
  window.location.reload();
}

// Catégories et types d'instruments : la valeur enregistrée reste en français.
const CATEGORY_EN = {
  Action: 'Stock',
  ETF: 'ETF',
  Fonds: 'Fund',
  Obligation: 'Bond',
  Crypto: 'Crypto',
  'Matière première': 'Commodity',
  Devise: 'Currency',
  Indice: 'Index',
  'Liquidités': 'Cash',
  Immobilier: 'Real estate',
  'Private equity': 'Private equity',
  Autre: 'Other',
  'Monétaire': 'Money market',
  'Contrat à terme': 'Futures',
};

export function tCategory(value) {
  return isEn && value && CATEGORY_EN[value] ? CATEGORY_EN[value] : value;
}

// Nom par défaut des liquidités (« Liquidités EUR ») ; un nom saisi par l'utilisateur n'est pas touché.
export function tName(name) {
  if (!isEn || !name) return name;
  const match = /^Liquidités ([A-Z]{3})$/.exec(name);
  return match ? `Cash ${match[1]}` : name;
}

// Messages du serveur (rédigés en français) : traduction par motifs.
const SERVER_RULES = [
  [/^Paramètre « (.+) » invalide\.$/, 'Invalid parameter "$1".'],
  [/^En-tête Content-Length invalide\.$/, 'Invalid Content-Length header.'],
  [/^Requête trop volumineuse\.$/, 'Request too large.'],
  [/^Le corps de la requête doit être du JSON\.$/, 'The request body must be JSON.'],
  [/^JSON invalide\.$/, 'Invalid JSON.'],
  [/^Un objet JSON est attendu\.$/, 'A JSON object is expected.'],
  [/^Hôte non autorisé\.$/, 'Host not allowed.'],
  [/^Méthode non autorisée\.$/, 'Method not allowed.'],
  [/^Requête refusée\.$/, 'Request refused.'],
  [/^Erreur interne du serveur\.$/, 'Internal server error.'],
  [/^Ressource introuvable\.$/, 'Resource not found.'],
  [/^Fichier introuvable\.$/, 'File not found.'],
  [/^Requête invalide\.$/, 'Invalid request.'],
  [/^Type d'actif inconnu\.$/, 'Unknown asset type.'],
  [/^Fournisseur de cours inconnu : (.+)\.$/, 'Unknown price provider: $1.'],
  [/^Fournisseur de cours inconnu\.$/, 'Unknown price provider.'],
  [/^Symbole d'instrument invalide\.$/, 'Invalid instrument symbol.'],
  [/^Actif introuvable\.$/, 'Asset not found.'],
  [/^Symbole « (.+) » introuvable sur Yahoo Finance\.$/, 'Symbol "$1" not found on Yahoo Finance.'],
  [/^Aucun cours disponible pour « (.+) » sur Yahoo Finance\.$/, 'No price available for "$1" on Yahoo Finance.'],
  [/^Taux de change (.+) -> USD indisponible\.$/, 'Exchange rate $1 -> USD unavailable.'],
  [/^Recherche Yahoo Finance indisponible : (.+)\.$/, (m, e) => `Yahoo Finance search unavailable: ${tServer(e)}.`],
  [/^Recherche CoinGecko indisponible : (.+)\.$/, (m, e) => `CoinGecko search unavailable: ${tServer(e)}.`],
  [/^Yahoo Finance \((.+?)\) : (.+)\.$/, (m, s, e) => `Yahoo Finance (${s}): ${tServer(e)}.`],
  [/^ressource introuvable$/, 'resource not found'],
  [/^trop de requêtes, réessayez dans une minute$/, 'too many requests, try again in a minute'],
  [/^erreur HTTP (\d+)$/, 'HTTP error $1'],
  [/^service injoignable \(connexion Internet \?\)$/, 'service unreachable (Internet connection?)'],
  [/^service injoignable$/, 'service unreachable'],
  [/^réponse illisible du service$/, 'unreadable response from the service'],
  [/^Nom : champ requis\.$/, 'Name: required field.'],
];

const FIELD_EN = {
  'Quantité': 'Quantity',
  'Lieu de détention': 'Holding location',
  'Catégorie': 'Category',
  Nom: 'Name',
  'Unité': 'Unit',
  Montant: 'Amount',
  "Prix d'achat unitaire": 'Unit purchase price',
  "Devise d'achat": 'Purchase currency',
  'Valeur unitaire': 'Unit value',
  Devise: 'Currency',
};
const fieldEn = (label) => FIELD_EN[label] ?? label;

// Validation des champs : « <libellé> : nombre invalide. », « <libellé> doit être strictement positif. »…
const FIELD_RULES = [
  [/^(.+) : valeur requise\.$/, (m, f) => `${fieldEn(f)}: value required.`],
  [/^(.+) : nombre invalide\.$/, (m, f) => `${fieldEn(f)}: invalid number.`],
  [/^(.+) doit être strictement positif\.$/, (m, f) => `${fieldEn(f)} must be strictly positive.`],
  [/^(.+) doit être positif ou nul\.$/, (m, f) => `${fieldEn(f)} must be zero or positive.`],
  [/^(.+) : valeur trop grande\.$/, (m, f) => `${fieldEn(f)}: value too large.`],
  [/^(.+) : texte attendu\.$/, (m, f) => `${fieldEn(f)}: text expected.`],
  [/^(.+) : champ requis\.$/, (m, f) => `${fieldEn(f)}: required field.`],
  [/^(.+) : (\d+) caractères maximum\.$/, (m, f, n) => `${fieldEn(f)}: ${n} characters maximum.`],
  [/^(.+) : devise requise\.$/, (m, f) => `${fieldEn(f)}: currency required.`],
  [/^(.+) : code devise invalide \(ex\. USD, EUR\)\.$/, (m, f) => `${fieldEn(f)}: invalid currency code (e.g. USD, EUR).`],
];

export function tServer(message) {
  if (!isEn || typeof message !== 'string') return message;
  for (const [pattern, replacement] of [...SERVER_RULES, ...FIELD_RULES]) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message;
}

// Textes statiques de index.html : attributs data-en, data-en-placeholder, data-en-title, data-en-aria-label.
export function applyStaticTranslations(root = document) {
  document.documentElement.lang = LANG;
  if (!isEn) return;
  for (const el of root.querySelectorAll('[data-en]')) el.textContent = el.dataset.en;
  for (const el of root.querySelectorAll('[data-en-placeholder]')) el.placeholder = el.dataset.enPlaceholder;
  for (const el of root.querySelectorAll('[data-en-title]')) el.title = el.dataset.enTitle;
  for (const el of root.querySelectorAll('[data-en-aria-label]')) el.setAttribute('aria-label', el.dataset.enAriaLabel);
}
