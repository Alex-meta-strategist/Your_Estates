// Colonne de gauche : « Mes actifs » (recherche, résultat épinglé, top 5, déclaration).
import { clear, h } from './dom.js';
import { icon } from './icons.js';
import { fmtCount, fmtDateTime, fmtPctChange, fmtQtyUnit, fmtShare, fmtUsd, fmtUsdPrice, isNum } from './format.js';
import { filterAssets, slotColor, unitLabel } from './logic.js';
import { t, tCategory, tServer } from './i18n.js';
import { delta, emptyState } from './ui.js';

export function createAssetsPanel(actions) {
  const els = {
    count: document.getElementById('assets-count'),
    input: document.getElementById('asset-search-input'),
    list: document.getElementById('asset-search-list'),
    pinned: document.getElementById('pinned-region'),
    top: document.getElementById('top-list'),
    more: document.getElementById('more-hint'),
    add: document.getElementById('add-asset-btn'),
  };
  let view = null;
  let options = [];
  let activeIndex = -1;
  let listOpen = false;

  els.add.addEventListener('click', () => actions.onAdd());
  els.more.addEventListener('click', () => openSearch());
  els.input.addEventListener('input', () => {
    activeIndex = -1;
    openList();
  });
  els.input.addEventListener('focus', openList);
  els.input.addEventListener('click', openList);
  els.input.addEventListener('blur', closeList);
  els.input.addEventListener('keydown', onKeyDown);
  els.list.addEventListener('mousedown', (event) => event.preventDefault()); // garde le focus dans le champ

  function openSearch(query) {
    if (typeof query === 'string') els.input.value = query;
    els.input.focus();
    openList();
  }

  function openList() {
    listOpen = true;
    renderList();
  }

  function closeList() {
    listOpen = false;
    activeIndex = -1;
    els.list.hidden = true;
    els.input.setAttribute('aria-expanded', 'false');
    els.input.removeAttribute('aria-activedescendant');
  }

  function colorOf(asset) {
    return slotColor(view?.slots.has(asset.id) ? view.slots.get(asset.id) : null);
  }

  function renderList() {
    if (!listOpen || !view) return;
    options = filterAssets(view.assets, els.input.value).slice(0, 50);
    clear(els.list);
    if (!options.length) {
      els.list.append(h('li', { class: 'search-message' },
        view.assets.length
          ? t('Aucun actif ne correspond.', 'No matching asset.')
          : t('Aucun actif déclaré pour le moment.', 'No assets declared yet.')));
    }
    options.forEach((asset, index) => {
      const active = index === activeIndex;
      const option = h('li', {
        id: `asset-option-${asset.id}`,
        role: 'option',
        class: `search-option${active ? ' is-active' : ''}`,
        'aria-selected': active ? 'true' : 'false',
        style: { '--asset-color': colorOf(asset) },
      },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('div', {},
          h('div', { class: 'so-name' }, view.labels.get(asset.id)),
          h('div', { class: 'so-sub' }, [asset.ticker, asset.location].filter(Boolean).join(' · '))),
        h('span', { class: 'so-value' }, fmtUsd(asset.valueUsd)));
      option.addEventListener('click', () => choose(asset));
      els.list.append(option);
    });
    els.list.hidden = false;
    els.input.setAttribute('aria-expanded', 'true');
    const active = options[activeIndex];
    if (active) {
      els.input.setAttribute('aria-activedescendant', `asset-option-${active.id}`);
      document.getElementById(`asset-option-${active.id}`)?.scrollIntoView({ block: 'nearest' });
    } else {
      els.input.removeAttribute('aria-activedescendant');
    }
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!listOpen) openList();
      if (!options.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + step + options.length) % options.length;
      renderList();
    } else if (event.key === 'Enter') {
      const target = options[activeIndex] ?? (els.input.value.trim() && options.length ? options[0] : null);
      if (target) {
        event.preventDefault();
        choose(target);
      }
    } else if (event.key === 'Escape' && listOpen) {
      event.preventDefault();
      closeList();
    }
  }

  function choose(asset) {
    els.input.value = '';
    closeList();
    actions.onPin(asset.id);
    requestAnimationFrame(() => els.pinned.querySelector('.ac-main')?.focus());
  }

  function stat(label, value) {
    return h('div', {}, h('dt', {}, label), h('dd', { title: value }, value));
  }

  function priceLine(asset) {
    if (!isNum(asset.priceUsd)) return t('Cours indisponible', 'Price unavailable');
    const parts = [fmtUsdPrice(asset.priceUsd)];
    if (isNum(asset.changePct)) parts.push(' ', delta(asset.changePct, fmtPctChange(asset.changePct)));
    return parts;
  }

  function warning(asset) {
    if (asset.quoteError) {
      const since = asset.quoteUpdatedAt
        ? t(` Dernier cours connu : ${fmtDateTime(asset.quoteUpdatedAt)}.`, ` Last known price: ${fmtDateTime(asset.quoteUpdatedAt)}.`)
        : '';
      return h('div', { class: 'ac-warning', title: `${tServer(asset.quoteError)}${since}` },
        icon('alert', { size: 14 }), t('Cours non actualisé (dernier connu affiché)', 'Price not refreshed (last known shown)'));
    }
    if (!isNum(asset.valueUsd)) {
      return h('div', { class: 'ac-warning' }, icon('alert', { size: 14 }), t('Cours indisponible pour le moment', 'Price unavailable for now'));
    }
    return null;
  }

  function actionButton(name, label, handler, { iconOnly = false } = {}) {
    return h('button', {
      type: 'button',
      class: iconOnly ? 'btn btn-sm btn-icon-only' : 'btn btn-sm',
      'aria-label': iconOnly ? label : null,
      title: iconOnly ? label : null,
      onclick: (event) => {
        event.stopPropagation();
        handler();
      },
    }, icon(name, { size: 14 }), iconOnly ? null : label);
  }

  function card(asset, { tag = 'li', pinned = false } = {}) {
    const selected = view.selected?.id === asset.id;
    const label = view.labels.get(asset.id) ?? asset.name;
    const priced = isNum(asset.valueUsd);
    const main = h('div', {
      class: 'ac-main',
      role: 'button',
      tabindex: '0',
      'aria-pressed': selected ? 'true' : 'false',
      'aria-label': t(
        `${label} : ${priced ? fmtUsd(asset.valueUsd) : 'cours indisponible'}, `
          + `${fmtQtyUnit(asset.quantity, unitLabel(asset))}, ${fmtShare(asset.share)} du portefeuille, `
          + `détenu chez ${asset.location || 'lieu non précisé'}`,
        `${label}: ${priced ? fmtUsd(asset.valueUsd) : 'price unavailable'}, `
          + `${fmtQtyUnit(asset.quantity, unitLabel(asset))}, ${fmtShare(asset.share)} of the portfolio, `
          + `held at ${asset.location || 'unspecified location'}`),
      dataset: { focusKey: `${pinned ? 'pinned' : 'top'}-${asset.id}` },
    },
      h('div', { class: 'ac-head' },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('div', { class: 'ac-title' },
          h('div', { class: 'ac-name', title: label }, label),
          h('div', { class: 'ac-sub' }, [asset.ticker, tCategory(asset.category)].filter(Boolean).join(' · '))),
        h('div', { class: 'ac-value' },
          h('div', { class: 'ac-amount' }, priced ? fmtUsd(asset.valueUsd) : '—'),
          h('div', { class: 'ac-price' }, priceLine(asset)))),
      h('dl', { class: 'ac-stats' },
        stat(t('Quantité', 'Quantity'), fmtQtyUnit(asset.quantity, unitLabel(asset))),
        stat(t('Part', 'Share'), fmtShare(asset.share)),
        stat(t('Lieu', 'Location'), asset.location || '—')),
      h('div', { class: 'meter', 'aria-hidden': 'true' },
        h('span', { style: { width: `${Math.min(100, Math.max(0, (asset.share || 0) * 100)).toFixed(2)}%` } })),
      warning(asset));
    main.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        actions.onSelect(asset.id);
      }
    });
    const container = h(tag, {
      class: `asset-card${selected ? ' is-selected' : ''}`,
      style: { '--asset-color': colorOf(asset) },
    }, main, selected ? h('div', { class: 'ac-actions' },
      actionButton('edit', t('Modifier', 'Edit'), () => actions.onEdit(asset)),
      actionButton('history', t('Historique', 'History'), () => actions.onHistory(asset)),
      actionButton('trash', t('Supprimer', 'Delete'), () => actions.onDelete(asset), { iconOnly: true })) : null);
    container.addEventListener('click', () => actions.onSelect(asset.id));
    return container;
  }

  function render(nextView) {
    view = nextView;
    const focusKey = document.activeElement?.dataset?.focusKey;

    els.count.textContent = view.assets.length ? fmtCount(view.assets.length, t('actif', 'asset')) : '';

    clear(els.pinned);
    if (view.pinned) {
      els.pinned.append(h('div', { class: 'pinned' },
        h('div', { class: 'section-label' },
          h('span', {}, view.pinnedLabel),
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            'aria-label': t(`Retirer de l'affichage : ${view.labels.get(view.pinned.id)}`, `Remove from view: ${view.labels.get(view.pinned.id)}`),
            onclick: () => actions.onUnpin(),
          }, icon('close', { size: 14 }), t('Retirer', 'Remove'))),
        card(view.pinned, { tag: 'div', pinned: true })));
    }

    clear(els.top);
    if (view.loading) {
      els.top.append(emptyState(t('Chargement…', 'Loading…'), 'li'));
    } else if (!view.assets.length) {
      els.top.append(emptyState(t("Aucun actif pour l'instant. Déclarez votre premier actif avec le bouton ci-dessous.",
        'No assets yet. Declare your first asset with the button below.'), 'li'));
    } else {
      for (const asset of view.top) els.top.append(card(asset));
    }

    const rest = view.assets.length - view.top.length;
    els.more.hidden = rest <= 0;
    if (rest > 0) {
      els.more.textContent = rest === 1
        ? t("Voir l'autre actif via la recherche", 'See the other asset via search')
        : t(`Voir les ${rest} autres actifs via la recherche`, `See the ${rest} other assets via search`);
    }

    if (listOpen) renderList();
    if (focusKey) document.querySelector(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  return { render, openSearch };
}
