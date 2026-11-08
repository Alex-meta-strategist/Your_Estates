// Boîte de dialogue « Historique des entrées » : le journal de toutes les saisies.
import { api } from './api.js';
import { clear, h } from './dom.js';
import { fmtDateTimeLong, fmtMoney, fmtQty, fmtQtyUnit } from './format.js';
import { t, tCategory, tName } from './i18n.js';
import { unitLabel } from './logic.js';

const TYPES = {
  create: { label: t('Déclaration', 'Declared'), className: 'tl-create' },
  update: { label: t('Modification', 'Edited'), className: 'tl-update' },
  archive: { label: t('Suppression', 'Deleted'), className: 'tl-archive' },
};
const FIELDS = {
  name: t('Nom', 'Name'),
  category: t('Catégorie', 'Category'),
  location: t('Lieu de détention', 'Holding location'),
  quantity: t('Quantité', 'Quantity'),
  initialUnitPrice: t("Prix d'achat unitaire", 'Unit purchase price'),
  initialCurrency: t("Devise d'achat", 'Purchase currency'),
  manualPrice: t('Valeur unitaire', 'Unit value'),
  quoteCurrency: t('Devise', 'Currency'),
  ticker: t('Unité', 'Unit'),
};
const SEP = t(' : ', ': ');

export function createHistoryDialog() {
  const dialog = document.getElementById('history-dialog');
  const filter = document.getElementById('history-filter');
  const list = document.getElementById('history-list');
  let seq = 0;

  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  filter.addEventListener('change', () => load(filter.value ? Number(filter.value) : null));

  async function open(assetId = null) {
    if (!dialog.open) dialog.showModal();
    await load(assetId);
  }

  async function load(assetId) {
    const current = ++seq;
    clear(list);
    list.append(h('li', { class: 'empty-state' }, t('Chargement…', 'Loading…')));
    try {
      const data = await api.events(assetId);
      if (current !== seq) return;
      fillFilter(data.assets, assetId);
      clear(list);
      if (!data.events.length) {
        list.append(h('li', { class: 'empty-state' }, t('Aucune entrée pour le moment.', 'No entries yet.')));
        return;
      }
      for (const event of data.events) list.append(entry(event));
    } catch (error) {
      if (current !== seq) return;
      clear(list);
      list.append(h('li', { class: 'empty-state' }, error.message));
    }
  }

  function fillFilter(assets, assetId) {
    const options = [h('option', { value: '' }, t('Tous les actifs', 'All assets'))];
    for (const asset of assets) {
      const suffix = [asset.location, asset.archived ? t('supprimé', 'deleted') : null].filter(Boolean).join(', ');
      const name = tName(asset.name);
      options.push(h('option', { value: String(asset.id) }, suffix ? `${name} (${suffix})` : name));
    }
    filter.replaceChildren(...options);
    filter.value = assetId ? String(assetId) : '';
  }

  return { open };
}

function entry(event) {
  const type = TYPES[event.type] ?? { label: event.type, className: '' };
  const asset = event.asset;
  return h('li', { class: `tl-item ${type.className}` },
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h('div', {},
      h('div', { class: 'tl-head' },
        h('span', { class: 'tl-type' }, type.label),
        h('time', { class: 'tl-date', datetime: event.createdAt }, fmtDateTimeLong(event.createdAt))),
      h('div', { class: 'tl-asset' },
        tName(asset.name),
        h('span', { class: 'muted' }, ` · ${[asset.ticker, asset.location].filter(Boolean).join(' · ')}`)),
      h('ul', { class: 'tl-details' }, details(event))));
}

function details(event) {
  const asset = event.asset;
  if (event.type === 'update' && event.changes) {
    return Object.entries(event.changes).map(([field, change]) => h('li', {},
      `${FIELDS[field] ?? field}${SEP}`,
      formatValue(field, change.from, event.changes, 'from', asset),
      ' → ',
      h('strong', {}, formatValue(field, change.to, event.changes, 'to', asset))));
  }
  const lines = [];
  if (asset.kind === 'cash') {
    lines.push(`${t('Montant', 'Amount')}${SEP}${fmtMoney(asset.quantity, asset.quoteCurrency)}`);
  } else {
    lines.push(`${FIELDS.quantity}${SEP}${fmtQtyUnit(asset.quantity, unitLabel(asset))}`);
    lines.push(`${FIELDS.initialUnitPrice}${SEP}${fmtMoney(asset.initialUnitPrice, asset.initialCurrency)}`);
  }
  if (asset.kind === 'manual') lines.push(`${FIELDS.manualPrice}${SEP}${fmtMoney(asset.manualPrice, asset.quoteCurrency)}`);
  if (event.type === 'archive') lines.push(t("Retiré du portefeuille ; l'historique est conservé.", 'Removed from the portfolio; the history is kept.'));
  return lines.map((line) => h('li', {}, line));
}

// Un prix modifié s'affiche dans sa devise d'alors (la devise a pu changer dans la même saisie).
function formatValue(field, value, changes, side, asset) {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'quantity') return fmtQty(value);
  if (field === 'initialUnitPrice') return fmtMoney(value, changes.initialCurrency?.[side] ?? asset.initialCurrency);
  if (field === 'manualPrice') return fmtMoney(value, changes.quoteCurrency?.[side] ?? asset.quoteCurrency);
  if (field === 'category') return tCategory(String(value));
  if (field === 'name') return tName(String(value));
  return String(value);
}
