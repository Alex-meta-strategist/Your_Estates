// Mise en forme des nombres et des dates (langue de l'interface, valeurs en dollars).
import { isEn, LOCALE, t } from './i18n.js';

const cache = new Map();

function nf(options) {
  const key = JSON.stringify(options);
  if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(LOCALE, options));
  return cache.get(key);
}

export const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

const USD = { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' };

export function fmtUsd(value) {
  return isNum(value) ? nf({ ...USD, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) : '—';
}

export function fmtUsdSigned(value) {
  return isNum(value)
    ? nf({ ...USD, minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(value)
    : '—';
}

// Cours unitaire : 2 décimales au-dessus d'un dollar, chiffres significatifs en dessous (cryptos à petit prix).
export function fmtUsdPrice(value) {
  if (!isNum(value)) return '—';
  if (value === 0 || Math.abs(value) >= 1) return fmtUsd(value);
  return nf({ ...USD, maximumSignificantDigits: 4 }).format(value);
}

// Montant dans une devise quelconque ; les sous-unités (GBp, ZAc…) ne sont pas des codes ISO.
export function fmtMoney(value, currency) {
  if (!isNum(value)) return '—';
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      const options = { style: 'currency', currency, currencyDisplay: 'narrowSymbol' };
      if (value !== 0 && Math.abs(value) < 1) options.maximumSignificantDigits = 4;
      return nf(options).format(value);
    } catch {
      /* devise inconnue d'Intl : affichage générique ci-dessous */
    }
  }
  return `${nf({ maximumFractionDigits: 4 }).format(value)} ${currency ?? ''}`.trim();
}

// Part d'un tout (0,324 -> « 32,4 % »).
export function fmtShare(ratio) {
  return isNum(ratio) ? nf({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ratio) : '—';
}

// Version courte pour l'intérieur des barres : « 32 % », « 4,5 % ».
export function fmtShareShort(ratio) {
  if (!isNum(ratio)) return '—';
  const digits = ratio >= 0.1 ? 0 : 1;
  return nf({ style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio);
}

// Variation exprimée en ratio (0,012 -> « +1,2 % »).
export function fmtRatioChange(ratio) {
  return isNum(ratio)
    ? nf({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio)
    : '—';
}

// Variation exprimée en pourcentage (1,25 -> « +1,25 % »).
export function fmtPctChange(pct) {
  return isNum(pct)
    ? nf({ style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(pct / 100)
    : '—';
}

export function fmtQty(value) {
  if (!isNum(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return nf({ maximumFractionDigits: digits }).format(value);
}

// Quantité suivie de son unité, sans retour à la ligne entre les deux : « 40 CW8.PA ».
export function fmtQtyUnit(value, unit) {
  return `${fmtQty(value)} ${unit}`;
}

export function fmtCount(value, singular, plural = `${singular}s`) {
  return `${nf({}).format(value)} ${value > 1 ? plural : singular}`;
}

const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'short' });
const dateTimeLong = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long', timeStyle: 'medium' });

export const fmtDateTime = (iso) => (iso ? dateTime.format(new Date(iso)) : '—');
export const fmtDateTimeLong = (iso) => (iso ? dateTimeLong.format(new Date(iso)) : '—');

export function fmtRelative(iso, now = Date.now()) {
  if (!iso) return t('jamais', 'never');
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return t("à l'instant", 'just now');
  if (seconds < 60) return t(`il y a ${seconds} s`, `${seconds} s ago`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t(`il y a ${minutes} min`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`il y a ${hours} h`, `${hours} h ago`);
  return t(`le ${fmtDateTime(iso)}`, `on ${fmtDateTime(iso)}`);
}

// Lecture d'un nombre saisi : « 1 234,56 », « 1234.56 » ou, à l'anglaise, « 1,234.56 ».
export function parseDecimal(input) {
  if (typeof input === 'number') return input;
  let text = String(input ?? '').trim().replace(/[\s  ']/g, '');
  // Virgule et point ensemble : le dernier est le séparateur décimal, l'autre groupe les milliers.
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '') : text.replace(/,/g, '');
  } else if (isEn && /^[+-]?\d{1,3}(,\d{3})+$/.test(text)) {
    text = text.replace(/,/g, ''); // « 1,234 » en anglais : séparateur de milliers
  }
  text = text.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return Number.NaN;
  return Number(text);
}

// Valeur pré-remplie dans un champ : séparateur décimal de la langue, sans séparateur de milliers.
export function toInputValue(value, maxDigits = 8) {
  return isNum(value) ? nf({ maximumFractionDigits: maxDigits, useGrouping: false }).format(value) : '';
}
