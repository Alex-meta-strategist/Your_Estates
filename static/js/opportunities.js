// Colonne de droite : « Opportunités ».
// Si je vends l'actif sélectionné, combien d'unités de chacun de mes autres actifs pourrais-je obtenir ?
import { clear, h } from './dom.js';
import { fmtQty, fmtQtyUnit, fmtRatioChange, fmtShare, fmtUsd, fmtUsdPrice, isNum } from './format.js';
import { computeOpportunities, simulateGroups, slotColor, unitLabel } from './logic.js';
import { t, tName } from './i18n.js';
import { emptyState } from './ui.js';

export function createOpportunities({ onRatioChange }) {
  const els = {
    sell: document.getElementById('sell-region'),
    box: document.getElementById('sell-ratio-box'),
    ratio: document.getElementById('sell-ratio'),
    output: document.getElementById('sell-ratio-out'),
    preview: document.getElementById('sell-preview'),
    list: document.getElementById('opps-region'),
  };
  let lastView = null;
  let targetKey = null; // instrument acheté dans la simulation (par défaut : le premier de la liste)
  els.ratio.addEventListener('input', () => onRatioChange(Number(els.ratio.value) / 100));

  function colorOf(assetIds, view) {
    const id = assetIds.find((assetId) => view.slots.has(assetId));
    return slotColor(id === undefined ? null : view.slots.get(id));
  }

  // Aperçu : deux barres fines (avant / après) de la répartition par valeur actuelle.
  function miniBar(groups, field, total, label) {
    return h('div', { class: 'mini-row' },
      h('span', { class: 'mini-label' }, label),
      h('div', { class: 'mini-bar', role: 'img', 'aria-label': t(`Répartition ${label.toLowerCase()} l'opération`, `Breakdown ${label.toLowerCase()} the trade`) },
        groups.filter((group) => group[field] > 0).map((group) => h('span', {
          title: `${group.label} : ${fmtShare(group[field] / total)}`,
          style: { 'flex-grow': String(Math.max(group[field] / total, 0.0001) * 1000), '--seg-color': slotColor(group.slot) },
        }))));
  }

  function renderPreview(view, result, target) {
    clear(els.preview);
    const total = view.groups.reduce((sum, group) => sum + group.current, 0);
    els.preview.hidden = !target || !(total > 0);
    if (els.preview.hidden) return;
    const groups = simulateGroups(view.groups, view.selected, target.assetIds, result.proceeds);
    const moved = groups.filter((group) => Math.abs(group.after - group.current) > 1e-9);
    els.preview.append(
      h('div', { class: 'section-label' },
        h('span', {}, t('Répartition après opération', 'Breakdown after the trade')),
        h('span', { title: tName(target.asset.name) }, t(`Achat : ${tName(target.asset.name)}`, `Buy: ${tName(target.asset.name)}`))),
      miniBar(groups, 'current', total, t('Avant', 'Before')),
      miniBar(groups, 'after', total, t('Après', 'After')),
      h('ul', { class: 'mini-legend' }, moved.map((group) => h('li', {},
        h('span', { class: 'legend-swatch', style: { '--seg-color': slotColor(group.slot) } }),
        h('span', { class: 'mini-name' }, group.label),
        h('span', { class: 'mini-shares' }, `${fmtShare(group.current / total)} → ${fmtShare(group.after / total)}`)))));
  }

  function render(view) {
    lastView = view;
    const focusKey = document.activeElement?.dataset?.oppKey;
    clear(els.sell);
    clear(els.list);
    els.preview.hidden = true;
    const selected = view.selected;
    if (view.loading || !view.assets.length || !selected) {
      els.box.hidden = true;
      let message = t('Sélectionnez un actif dans « Mes actifs » pour simuler sa vente.', 'Select an asset in "My assets" to simulate selling it.');
      if (view.loading) message = t('Chargement…', 'Loading…');
      else if (!view.assets.length) message = t('Déclarez vos actifs pour simuler des arbitrages entre eux.', 'Declare your assets to simulate trades between them.');
      els.list.append(emptyState(message));
      return;
    }

    const percent = Math.round(view.sellRatio * 100);
    if (els.ratio.value !== String(percent)) els.ratio.value = String(percent);
    els.output.textContent = t(`${percent} %`, `${percent}%`);
    els.box.hidden = false;

    const result = computeOpportunities(selected, view.assets, view.sellRatio);
    const unit = unitLabel(selected);
    els.sell.append(h('div', { class: 'sell-card', style: { '--asset-color': colorOf([selected.id], view) } },
      h('div', { class: 'sell-kicker' }, t('Si je vends', 'If I sell')),
      h('div', { class: 'sell-name' },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('span', {}, view.labels.get(selected.id))),
      h('div', { class: 'sell-detail' },
        t(`${fmtQtyUnit(result.soldQuantity, unit)} sur ${fmtQty(selected.quantity)} · ${selected.location || 'lieu non précisé'}`,
          `${fmtQtyUnit(result.soldQuantity, unit)} of ${fmtQty(selected.quantity)} · ${selected.location || 'unspecified location'}`)),
      h('div', { class: 'sell-proceeds' },
        h('span', { class: 'sell-detail' }, t('Produit de la vente', 'Sale proceeds')),
        h('strong', {}, isNum(result.proceeds) ? fmtUsd(result.proceeds) : '—'))));

    if (!isNum(result.proceeds)) {
      els.list.append(emptyState(t("Le cours de cet actif est indisponible : impossible d'estimer le produit de la vente.",
        "This asset's price is unavailable: the sale proceeds cannot be estimated.")));
      return;
    }
    if (!result.items.length) {
      els.list.append(emptyState(t("Déclarez d'autres actifs pour voir ce que cette vente permettrait d'acquérir.",
        'Declare other assets to see what this sale could buy.')));
      return;
    }

    const target = result.items.find((item) => item.key === targetKey) ?? result.items[0];
    renderPreview(view, result, target);

    els.list.append(h('div', { class: 'section-label' },
      h('span', {}, t('Je pourrais obtenir', 'I could get')),
      h('span', {}, result.candidateCount > result.items.length
        ? t(`Top ${result.items.length} sur ${result.candidateCount}`, `Top ${result.items.length} of ${result.candidateCount}`)
        : `Top ${result.items.length}`)));
    els.list.append(h('ol', { class: 'opp-list' }, result.items.map((item, index) => {
      const asset = item.asset;
      const itemUnit = unitLabel(asset);
      const label = item.assetIds.length > 1 ? tName(asset.name) : view.labels.get(asset.id);
      const chosen = item === target;
      const pick = () => {
        targetKey = item.key;
        render(lastView);
      };
      return h('li', {
        class: `opp${chosen ? ' is-target' : ''}`,
        role: 'button',
        tabindex: '0',
        'aria-pressed': chosen ? 'true' : 'false',
        title: t("Simuler l'achat de cet actif dans l'aperçu", 'Simulate buying this asset in the preview'),
        dataset: { oppKey: item.key },
        style: { '--asset-color': colorOf(item.assetIds, view) },
        onclick: pick,
        onkeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            pick();
          }
        },
      },
        h('span', { class: 'opp-rank', 'aria-hidden': 'true' }, String(index + 1)),
        h('div', { class: 'opp-body' },
          h('div', { class: 'opp-head' },
            h('span', { class: 'swatch', 'aria-hidden': 'true' }),
            h('span', { class: 'opp-name', title: label }, label),
            asset.ticker && asset.ticker !== label ? h('span', { class: 'opp-ticker' }, asset.ticker) : null),
          // Mise en avant : la hausse de ma position ; la quantité obtenue passe en détail.
          h('div', { class: 'opp-qty' }, isNum(item.growth)
            ? fmtRatioChange(item.growth)
            : `≈ ${fmtQtyUnit(item.quantity, itemUnit)}`),
          isNum(item.growth)
            ? h('div', { class: 'opp-meta' },
              t(`soit ≈ ${fmtQtyUnit(item.quantity, itemUnit)} en plus de ma position (${fmtQtyUnit(item.heldQuantity, itemUnit)})`,
                `i.e. ≈ ${fmtQtyUnit(item.quantity, itemUnit)} on top of my position (${fmtQtyUnit(item.heldQuantity, itemUnit)})`))
            : null,
          h('div', { class: 'opp-meta' }, t(`au cours de ${fmtUsdPrice(item.priceUsd)} par ${itemUnit}`,
            `at ${fmtUsdPrice(item.priceUsd)} per ${itemUnit}`))));
    })));
    if (focusKey) {
      [...els.list.querySelectorAll('[data-opp-key]')].find((el) => el.dataset.oppKey === focusKey)?.focus({ preventScroll: true });
    }
  }

  return { render };
}
