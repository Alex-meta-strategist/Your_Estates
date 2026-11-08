// Calculs purs (sans DOM) : groupes des graphiques, couleurs, opportunités, recherche.
import { isNum } from './format.js';
import { LOCALE, t, tName } from './i18n.js';

export const TOP_COUNT = 5;

// Un même instrument peut être détenu à plusieurs endroits (BTC sur Binance et sur un Ledger).
export function instrumentKey(asset) {
  return asset.provider === 'manual' ? `manual:${asset.id}` : `${asset.provider}:${asset.symbol}`;
}

// Unité affichée après une quantité : ticker (AAPL, BTC, EUR) ou « u. » pour un actif manuel.
export function unitLabel(asset) {
  return asset.ticker || t('u.', 'u.');
}

// Libellés lisibles ; on ajoute le lieu quand deux actifs portent le même nom.
export function displayLabels(assets) {
  const counts = new Map();
  for (const asset of assets) {
    const key = asset.name.toLocaleLowerCase(LOCALE);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labels = new Map();
  for (const asset of assets) {
    const duplicated = counts.get(asset.name.toLocaleLowerCase(LOCALE)) > 1;
    const name = tName(asset.name);
    labels.set(asset.id, duplicated && asset.location ? `${name} · ${asset.location}` : name);
  }
  return labels;
}

// La couleur suit l'actif, pas son rang : un actif garde sa couleur tant qu'il reste dans le top 5,
// et la retrouve s'il y revient. `memory` (id -> emplacement) est conservée entre deux sessions.
export function assignSlots(topIds, memory = {}, slotCount = TOP_COUNT) {
  const slots = new Map();
  const used = new Set();
  for (const id of topIds) {
    const slot = memory[id];
    if (Number.isInteger(slot) && slot >= 0 && slot < slotCount && !used.has(slot)) {
      slots.set(id, slot);
      used.add(slot);
    }
  }
  const nextMemory = { ...memory };
  for (const id of topIds) {
    if (slots.has(id)) continue;
    let slot = 0;
    while (used.has(slot)) slot += 1;
    slots.set(id, slot);
    used.add(slot);
    nextMemory[id] = slot;
  }
  return { slots, memory: nextMemory };
}

const sumOf = (assets, field) => assets.reduce((sum, a) => sum + (isNum(a[field]) ? a[field] : 0), 0);
const byValueDesc = (x, y) => (isNum(y.valueUsd) ? y.valueUsd : 0) - (isNum(x.valueUsd) ? x.valueUsd : 0);

function joinNames(names, max = 6) {
  return names.slice(0, max).join(', ') + (names.length > max ? '…' : '');
}

// Positions regroupées : les actifs du même instrument (même symbole coté) ou portant le même
// nom ne forment qu'une seule position, même s'ils sont détenus à plusieurs endroits.
export function groupPositions(assets) {
  const parent = new Map(assets.map((a) => [a.id, a.id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  const seen = new Map();
  const link = (key, id) => {
    if (seen.has(key)) parent.set(find(id), find(seen.get(key)));
    else seen.set(key, id);
  };
  for (const asset of assets) {
    link(`i:${instrumentKey(asset)}`, asset.id);
    link(`n:${normalizeText(asset.name)}`, asset.id);
  }
  const buckets = new Map();
  for (const asset of assets) {
    const root = find(asset.id);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(asset);
  }
  return [...buckets.values()].map((members) => {
    const sorted = [...members].sort(byValueDesc);
    const locations = [...new Set(sorted.map((a) => a.location).filter(Boolean))];
    return {
      // Identifiant stable : le plus ancien actif du groupe (sert de clé à la mémoire des couleurs).
      id: Math.min(...sorted.map((a) => a.id)),
      label: tName(sorted[0].name),
      assets: sorted,
      detail: sorted.length > 1
        ? t(`${sorted.length} lignes : ${joinNames(locations) || 'lieu non précisé'}`,
          `${sorted.length} lines: ${joinNames(locations) || 'unspecified location'}`)
        : null,
    };
  });
}

// Une position par plateforme (lieu de détention).
export function groupPlatforms(assets) {
  const buckets = new Map();
  for (const asset of assets) {
    const label = asset.location?.trim() || t('Non renseigné', 'Not specified');
    const key = normalizeText(label);
    if (!buckets.has(key)) buckets.set(key, { id: key, label, assets: [] });
    buckets.get(key).assets.push(asset);
  }
  return [...buckets.values()].map((bucket) => {
    const sorted = [...bucket.assets].sort(byValueDesc);
    const names = [...new Set(sorted.map((a) => tName(a.name)))];
    return { ...bucket, assets: sorted, detail: joinNames(names) };
  });
}

// Groupes d'un graphique : les 5 premières positions par valeur actuelle + « Autres ».
// Les blocs sont rangés par emplacement de couleur : l'ordre des couleurs adjacentes reste
// celui de la palette validée (daltonisme), et les blocs ne sautent pas d'une place à l'autre.
function buildGroups(buckets, memory) {
  for (const bucket of buckets) {
    bucket.current = sumOf(bucket.assets, 'valueUsd');
    bucket.initial = sumOf(bucket.assets, 'initialValueUsd');
  }
  const ranked = buckets.filter((b) => b.current > 0).sort((x, y) => y.current - x.current);
  const top = ranked.slice(0, TOP_COUNT);
  const { slots, memory: nextMemory } = assignSlots(top.map((b) => b.id), memory);
  const groups = top
    .map((b) => ({ ...b, key: `g-${b.id}`, slot: slots.get(b.id) }))
    .sort((x, y) => x.slot - y.slot);
  const topSet = new Set(top);
  const rest = buckets.filter((b) => !topSet.has(b)).sort((x, y) => y.current - x.current);
  if (rest.length) {
    const members = rest.flatMap((b) => b.assets);
    groups.push({
      key: 'other',
      slot: null,
      label: t(`Autres (${rest.length})`, `Others (${rest.length})`),
      assets: members,
      detail: joinNames(rest.map((b) => b.label)),
      current: sumOf(members, 'valueUsd'),
      initial: sumOf(members, 'initialValueUsd'),
    });
  }
  return { groups, memory: nextMemory };
}

// Répartition par actif. `slots` (id d'actif -> couleur) couvre toutes les lignes des 5 premières positions.
export function computeGroups(assets, memory = {}) {
  const { groups, memory: nextMemory } = buildGroups(groupPositions(assets), memory);
  const slots = new Map();
  for (const group of groups) {
    if (group.slot !== null) for (const asset of group.assets) slots.set(asset.id, group.slot);
  }
  return { groups, slots, memory: nextMemory };
}

// Répartition par plateforme.
export function computePlatformGroups(assets, memory = {}) {
  return buildGroups(groupPlatforms(assets), memory);
}

export function slotColor(slot) {
  return slot === null || slot === undefined ? 'var(--series-other)' : `var(--series-${slot + 1})`;
}

// Opportunités : si je vends `ratio` de l'actif sélectionné, combien d'unités de chacun
// de mes autres instruments puis-je acheter ? On retient les plus grosses positions du
// portefeuille, puis on les classe par hausse de position décroissante.
export function computeOpportunities(selected, assets, ratio = 1, limit = TOP_COUNT) {
  if (!selected) return null;
  const proceeds = isNum(selected.valueUsd) ? selected.valueUsd * ratio : null;
  const ownKey = instrumentKey(selected);
  const instruments = new Map();
  for (const asset of assets) {
    const key = instrumentKey(asset);
    if (key === ownKey || !isNum(asset.priceUsd) || asset.priceUsd <= 0) continue;
    let entry = instruments.get(key);
    if (!entry) {
      entry = { key, asset, assetIds: [], locations: [], priceUsd: asset.priceUsd, heldQuantity: 0, heldValueUsd: 0 };
      instruments.set(key, entry);
    }
    entry.assetIds.push(asset.id);
    if (asset.location && !entry.locations.includes(asset.location)) entry.locations.push(asset.location);
    entry.heldQuantity += asset.quantity;
    entry.heldValueUsd += isNum(asset.valueUsd) ? asset.valueUsd : 0;
  }
  const ranked = [...instruments.values()].sort((a, b) => b.heldValueUsd - a.heldValueUsd);
  const items = ranked.slice(0, limit).map((entry) => {
    const quantity = proceeds === null ? null : proceeds / entry.priceUsd;
    return {
      ...entry,
      quantity,
      growth: quantity !== null && entry.heldQuantity > 0 ? quantity / entry.heldQuantity : null,
    };
  });
  // Affichage : la plus forte hausse de position en premier.
  items.sort((a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity));
  return { proceeds, soldQuantity: selected.quantity * ratio, items, candidateCount: ranked.length };
}

// Répartition simulée : la vente retire `proceeds` du bloc de l'actif vendu et l'ajoute au bloc
// de l'instrument acheté (`targetIds`). Le total du portefeuille ne change pas.
export function simulateGroups(groups, selected, targetIds, proceeds) {
  const targets = new Set(targetIds);
  return groups.map((group) => {
    let after = group.current;
    if (group.assets.some((asset) => asset.id === selected.id)) after -= proceeds;
    if (group.assets.some((asset) => targets.has(asset.id))) after += proceeds;
    return { ...group, after: Math.max(after, 0) };
  });
}

// Recherche insensible à la casse et aux accents.
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function filterAssets(assets, query) {
  const needle = normalizeText(query);
  if (!needle) return assets;
  return assets.filter((a) =>
    [a.name, a.ticker, a.symbol, a.location, a.category].some((field) => normalizeText(field).includes(needle)));
}
