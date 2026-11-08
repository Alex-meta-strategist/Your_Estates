// Colonne du milieu : barres empilées « valeur actuelle », « valeur initiale » et « par plateforme ».
// Une barre = le portefeuille entier ; chaque bloc = une position du top 5, plus « Autres ».
// Les lignes du même instrument (ou du même nom) sont regroupées en une seule position.
import { clear, h } from './dom.js';
import { icon } from './icons.js';
import { fmtShare, fmtShareShort, fmtUsd } from './format.js';
import { slotColor } from './logic.js';
import { t } from './i18n.js';
import { prefs } from './prefs.js';

const FIGURES = [
  {
    id: 'chart-current',
    measure: 'current',
    title: t('Répartition · valeur actuelle', 'Breakdown · current value'),
    subtitle: t('Selon les derniers cours · top 5 et autres', 'Based on latest prices · top 5 and others'),
    valueLabel: t('Valeur actuelle', 'Current value'),
  },
  {
    id: 'chart-initial',
    measure: 'initial',
    title: t('Répartition · valeur initiale', 'Breakdown · initial value'),
    subtitle: t("Selon les prix d'achat · mêmes groupes que ci-dessus", 'Based on purchase prices · same groups as above'),
    valueLabel: t('Valeur initiale', 'Initial value'),
  },
  {
    id: 'chart-platform',
    name: 'platform',
    source: 'platformGroups',
    measure: 'current',
    title: t('Répartition · par plateforme', 'Breakdown · by platform'),
    subtitle: t('Valeur actuelle par lieu de détention · top 5 et autres', 'Current value by holding location · top 5 and others'),
    valueLabel: t('Valeur actuelle', 'Current value'),
    itemLabel: t('Plateforme', 'Platform'),
  },
];

export function createCharts({ onSelect, onShowOthers, onShowPlatform }) {
  const tooltip = createTooltip();
  const tableOpen = prefs.get('chartTables', { current: false, initial: false, platform: false });
  const figures = FIGURES.map((figure) => ({
    name: figure.measure,
    source: 'groups',
    itemLabel: t('Actif', 'Asset'),
    ...figure,
    el: document.getElementById(figure.id),
    bar: null,
  }));
  // Ajustement différé d'une image : modifier la mise en page dans le rappel lui-même
  // déclencherait l'avertissement « ResizeObserver loop » du navigateur.
  const observer = new ResizeObserver((entries) => {
    requestAnimationFrame(() => {
      for (const entry of entries) if (entry.target.isConnected) fitLabels(entry.target);
    });
  });
  let view = null;

  function render(nextView) {
    view = nextView;
    const active = document.activeElement;
    const focus = active?.dataset?.segKey ? { figure: active.closest('figure')?.id, key: active.dataset.segKey } : null;
    tooltip.hide();
    for (const figure of figures) renderFigure(figure);
    if (focus) {
      document.querySelector(`#${focus.figure} [data-seg-key="${CSS.escape(focus.key)}"]`)?.focus({ preventScroll: true });
    }
  }

  function groupLabel(group) {
    return group.label;
  }

  function isSelected(group) {
    return !!view.selected && group.assets.some((asset) => asset.id === view.selected.id);
  }

  function activate(group, figure) {
    if (group.key === 'other') onShowOthers();
    else if (figure.source === 'platformGroups') onShowPlatform(group.label);
    else onSelect(group.assets[0].id);
  }

  function renderFigure(figure) {
    const { el, measure, name } = figure;
    if (figure.bar) {
      observer.unobserve(figure.bar);
      figure.bar = null;
    }
    clear(el);
    const total = measure === 'current' ? view.totals.valueUsd : view.totals.initialValueUsd;
    const groups = view[figure.source].filter((group) => group[measure] > 0);

    el.append(h('figcaption', { class: 'chart-head' },
      h('div', {},
        h('h3', { class: 'chart-title' }, figure.title),
        h('p', { class: 'chart-sub' }, figure.subtitle)),
      h('div', { class: 'chart-total' }, view.loading ? '…' : fmtUsd(total))));

    if (!groups.length || !(total > 0)) {
      let message = t('Déclarez un actif pour voir la répartition.', 'Declare an asset to see the breakdown.');
      if (view.loading) message = t('Chargement…', 'Loading…');
      else if (view.assets.length) {
        message = measure === 'current'
          ? t('Aucun cours disponible pour le moment.', 'No price available for now.')
          : t('Aucune valeur initiale renseignée.', 'No initial value entered.');
      }
      el.append(h('p', { class: 'chart-empty' }, message));
      return;
    }

    const bar = h('div', { class: 'segbar', role: 'group', 'aria-label': `${figure.title}, total ${fmtUsd(total)}` },
      groups.map((group) => segment(group, measure, total, figure)));
    el.append(bar);
    el.append(h('ul', { class: 'legend', 'aria-label': t('Légende', 'Legend') }, groups.map((group) => h('li', {},
      h('button', {
        type: 'button',
        class: `legend-item${isSelected(group) ? ' is-selected' : ''}`,
        onclick: () => activate(group, figure),
      },
        h('span', { class: 'legend-swatch', style: { '--seg-color': slotColor(group.slot) } }),
        groupLabel(group))))));

    const open = !!tableOpen[name];
    const toggle = h('button', {
      type: 'button',
      class: 'link-btn',
      'aria-expanded': open ? 'true' : 'false',
      onclick: () => {
        tableOpen[name] = !open;
        prefs.set('chartTables', tableOpen);
        renderFigure(figure);
        figure.el.querySelector('.link-btn')?.focus();
      },
    }, icon('table', { size: 14 }), open ? t('Masquer le tableau', 'Hide table') : t('Afficher le tableau', 'Show table'));
    el.append(h('div', { class: 'chart-foot' }, toggle));
    if (open) el.append(table(groups, measure, total, figure));

    figure.bar = bar;
    observer.observe(bar);
    fitLabels(bar);
  }

  function segment(group, measure, total, figure) {
    const value = group[measure];
    const share = value / total;
    const label = groupLabel(group);
    const seg = h('div', {
      class: `seg${isSelected(group) ? ' is-selected' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${label} : ${fmtUsd(value)}, ${fmtShare(share)}`,
      dataset: { slot: group.slot === null ? 'other' : String(group.slot), segKey: group.key },
      style: { 'flex-grow': String(Math.max(share, 0.0001) * 1000), '--seg-color': slotColor(group.slot) },
    }, h('span', { class: 'seg-label', 'aria-hidden': 'true' }, fmtShareShort(share)));

    const content = () => tooltipContent(group, value, share, label, measure);
    seg.addEventListener('pointerenter', (event) => tooltip.show(content(), event.clientX, event.clientY));
    seg.addEventListener('pointermove', (event) => tooltip.move(event.clientX, event.clientY));
    seg.addEventListener('pointerleave', () => tooltip.hide());
    seg.addEventListener('focus', () => {
      const rect = seg.getBoundingClientRect();
      tooltip.show(content(), rect.left + Math.min(rect.width / 2, 40), rect.bottom);
    });
    seg.addEventListener('blur', () => tooltip.hide());
    seg.addEventListener('click', () => activate(group, figure));
    seg.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(group, figure);
      }
    });
    return seg;
  }

  function tooltipContent(group, value, share, label, measure) {
    const nodes = [
      h('div', { class: 'tt-value' }, fmtUsd(value)),
      h('div', { class: 'tt-name' }, h('span', { class: 'tt-key', style: { '--seg-color': slotColor(group.slot) } }), label),
      h('div', { class: 'tt-meta' }, t(`${fmtShare(share)} de la valeur ${measure === 'current' ? 'actuelle' : 'initiale'}`,
        `${fmtShare(share)} of the ${measure === 'current' ? 'current' : 'initial'} value`)),
    ];
    if (group.detail) nodes.push(h('div', { class: 'tt-meta' }, group.detail));
    return nodes;
  }

  function table(groups, measure, total, figure) {
    return h('table', { class: 'data-table' },
      h('caption', { class: 'visually-hidden' }, figure.title),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, figure.itemLabel),
        h('th', { scope: 'col', class: 'num' }, figure.valueLabel),
        h('th', { scope: 'col', class: 'num' }, t('Part', 'Share')))),
      h('tbody', {}, groups.map((group) => h('tr', { class: isSelected(group) ? 'is-selected' : null },
        h('td', {},
          h('div', { class: 'cell-asset' },
            h('span', { class: 'legend-swatch', style: { '--seg-color': slotColor(group.slot) } }),
            groupLabel(group)),
          group.detail ? h('div', { class: 'cell-sub' }, group.detail) : null),
        h('td', { class: 'num' }, fmtUsd(group[measure])),
        h('td', { class: 'num' }, fmtShare(group[measure] / total))))),
      h('tfoot', {}, h('tr', {},
        h('th', { scope: 'row' }, 'Total'),
        h('td', { class: 'num' }, fmtUsd(total)),
        h('td', { class: 'num' }, fmtShare(1)))));
  }

  return { render };
}

// Un libellé n'est affiché dans un bloc que s'il y tient entièrement (jamais tronqué).
function fitLabels(bar) {
  for (const seg of bar.children) {
    const label = seg.firstElementChild;
    if (!label) continue;
    label.hidden = false;
    label.hidden = label.offsetWidth > seg.clientWidth;
  }
}

function createTooltip() {
  const el = document.getElementById('tooltip');
  function move(x, y) {
    const pad = 14;
    const { width, height } = el.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + width > window.innerWidth - 8) left = x - width - pad;
    if (top + height > window.innerHeight - 8) top = y - height - pad;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }
  return {
    show(nodes, x, y) {
      el.replaceChildren(...nodes);
      el.hidden = false;
      move(x, y);
    },
    move,
    hide() {
      el.hidden = true;
    },
  };
}
