// Point d'entrée : état de l'application, rafraîchissement des cours et rendu des trois colonnes.
import { api } from './api.js';
import { createAssetDialog } from './asset-dialog.js';
import { createAssetsPanel } from './assets-panel.js';
import { createCharts } from './charts.js';
import { confirmAction } from './confirm.js';
import { clear, h } from './dom.js';
import { fmtCount, fmtDateTimeLong, fmtRatioChange, fmtRelative, fmtUsd, fmtUsdSigned, isNum } from './format.js';
import { createHistoryDialog } from './history-dialog.js';
import { applyStaticTranslations, isEn, setLang, t, tName, tServer } from './i18n.js';
import { hydrateIcons, icon } from './icons.js';
import { computeGroups, computePlatformGroups, displayLabels, TOP_COUNT } from './logic.js';
import { createOpportunities } from './opportunities.js';
import { prefs } from './prefs.js';
import { toast } from './toast.js';
import { delta } from './ui.js';

const AUTO_REFRESH_MS = 60_000;
const EMPTY_TOTALS = {
  valueUsd: 0, initialValueUsd: 0, pnlUsd: 0, pnlPct: null, dayChangeUsd: 0, dayChangePct: null,
  count: 0, pricedCount: 0, locations: 0,
};

const state = {
  portfolio: null,
  loadFailed: false,
  selectedId: prefs.get('selectedId', null),
  pinnedId: null,
  pinnedReason: 'search', // 'search' (recherche) ou 'created' (actif tout juste déclaré)
  sellRatio: 1,
  refreshing: false,
  refreshErrors: [],
  autoRefresh: prefs.get('autoRefresh', true),
};
let colorMemory = prefs.get('colorSlots', {});
let platformMemory = prefs.get('platformSlots', {});
let lastView = null;

const els = {
  layout: document.getElementById('layout'),
  status: document.getElementById('refresh-status'),
  refreshBtn: document.getElementById('refresh-btn'),
  historyBtn: document.getElementById('history-btn'),
  themeBtn: document.getElementById('theme-btn'),
  themeIcon: document.getElementById('theme-icon'),
  auto: document.getElementById('auto-refresh'),
  hero: document.getElementById('hero'),
  langBtn: document.getElementById('lang-btn'),
};

applyStaticTranslations();
hydrateIcons();
const refreshIcon = els.refreshBtn.querySelector('.btn-icon-slot');

const assetsPanel = createAssetsPanel({
  onSelect: select,
  onPin: (id) => {
    state.pinnedId = id;
    state.pinnedReason = 'search';
    select(id);
  },
  onUnpin: () => {
    state.pinnedId = null;
    render();
  },
  onAdd: () => assetDialog.openCreate(),
  onEdit: (asset) => assetDialog.openEdit(asset),
  onHistory: (asset) => historyDialog.open(asset.id),
  onDelete: deleteAsset,
});
const charts = createCharts({
  onSelect: select,
  onShowOthers: () => assetsPanel.openSearch(),
  onShowPlatform: (name) => assetsPanel.openSearch(name),
});
const opportunities = createOpportunities({
  onRatioChange: (ratio) => {
    state.sellRatio = ratio;
    if (lastView) opportunities.render({ ...lastView, sellRatio: ratio });
  },
});
const assetDialog = createAssetDialog({
  onSaved: (response, mode) => {
    state.portfolio = response.portfolio;
    if (mode === 'create') {
      state.selectedId = response.assetId;
      state.sellRatio = 1;
      prefs.set('selectedId', response.assetId);
      // Hors du top 5, le nouvel actif est affiché en haut de la liste pour rester visible.
      const rank = response.portfolio.assets.findIndex((asset) => asset.id === response.assetId);
      if (rank >= TOP_COUNT) {
        state.pinnedId = response.assetId;
        state.pinnedReason = 'created';
      }
      toast(t('Actif déclaré et enregistré.', 'Asset declared and saved.'), { type: 'success' });
    } else {
      toast(response.changed ? t('Modifications enregistrées.', 'Changes saved.') : t('Aucune modification.', 'No changes.'),
        { type: 'success' });
    }
    render();
  },
  getLocations: () => (state.portfolio?.assets ?? []).map((asset) => asset.location),
});
const historyDialog = createHistoryDialog();

// ------------------------------------------------------------------ actions

function select(id) {
  if (state.selectedId !== id) state.sellRatio = 1;
  state.selectedId = id;
  prefs.set('selectedId', id);
  render();
}

async function deleteAsset(asset) {
  const confirmed = await confirmAction({
    title: t('Supprimer cet actif ?', 'Delete this asset?'),
    message: t(
      `« ${tName(asset.name)} »${asset.location ? ` (${asset.location})` : ''} sera retiré du portefeuille. `
        + 'Son historique reste consultable.',
      `"${tName(asset.name)}"${asset.location ? ` (${asset.location})` : ''} will be removed from the portfolio. `
        + 'Its history remains available.'),
    confirmLabel: t('Supprimer', 'Delete'),
  });
  if (!confirmed) return;
  try {
    const response = await api.deleteAsset(asset.id);
    state.portfolio = response.portfolio;
    if (state.pinnedId === asset.id) state.pinnedId = null;
    render();
    toast(t('Actif supprimé. Son historique reste consultable.', 'Asset deleted. Its history remains available.'), { type: 'success' });
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function refresh({ silent = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  try {
    const portfolio = await api.refresh();
    state.portfolio = portfolio;
    state.loadFailed = false;
    state.refreshErrors = portfolio.refreshErrors ?? [];
    if (!silent) {
      if (state.refreshErrors.length) {
        const names = [...new Set(state.refreshErrors.map((error) => tName(error.name)))].join(', ');
        toast(t(`Cours indisponible pour : ${names}. Le dernier cours connu est conservé.`,
          `Price unavailable for: ${names}. The last known price is kept.`), { type: 'error', timeout: 7000 });
      } else {
        toast(t('Cours mis à jour.', 'Prices updated.'), { type: 'success', timeout: 2500 });
      }
    }
  } catch (error) {
    state.refreshErrors = [{ message: error.message }];
    if (!silent) toast(error.message, { type: 'error' });
  } finally {
    state.refreshing = false;
    render();
  }
}

// ------------------------------------------------------------------ rendu

function render() {
  const portfolio = state.portfolio;
  const assets = portfolio?.assets ?? [];
  if (assets.length && !assets.some((asset) => asset.id === state.selectedId)) {
    state.selectedId = assets[0].id;
    prefs.set('selectedId', state.selectedId);
  }
  if (state.pinnedId !== null && !assets.some((asset) => asset.id === state.pinnedId)) state.pinnedId = null;

  const { groups, slots, memory } = computeGroups(assets, colorMemory);
  const platforms = computePlatformGroups(assets, platformMemory);
  if (portfolio) {
    rememberColors(memory, assets);
    rememberPlatformColors(platforms.memory, platforms.groups);
  }

  const view = {
    assets,
    totals: portfolio?.totals ?? EMPTY_TOTALS,
    groups,
    platformGroups: platforms.groups,
    slots,
    labels: displayLabels(assets),
    selected: assets.find((asset) => asset.id === state.selectedId) ?? null,
    pinned: assets.find((asset) => asset.id === state.pinnedId) ?? null,
    pinnedLabel: state.pinnedReason === 'created' ? t('Nouvel actif', 'New asset') : t('Résultat de recherche', 'Search result'),
    top: assets.slice(0, TOP_COUNT),
    sellRatio: state.sellRatio,
    loading: !portfolio && !state.loadFailed,
  };
  lastView = view;

  renderStatus();
  renderHero(view);
  assetsPanel.render(view);
  charts.render(view);
  opportunities.render(view);
  els.layout.classList.toggle('is-refreshing', state.refreshing);
}

function rememberColors(memory, assets) {
  const ids = new Set(assets.map((asset) => String(asset.id)));
  const pruned = Object.fromEntries(Object.entries(memory).filter(([id]) => ids.has(id)));
  if (JSON.stringify(pruned) !== JSON.stringify(colorMemory)) {
    colorMemory = pruned;
    prefs.set('colorSlots', pruned);
  }
}

// Seules les plateformes affichées gardent leur couleur en mémoire.
function rememberPlatformColors(memory, groups) {
  const keys = new Set(groups.map((group) => group.id).filter((id) => id !== undefined));
  const pruned = Object.fromEntries(Object.entries(memory).filter(([key]) => keys.has(key)));
  if (JSON.stringify(pruned) !== JSON.stringify(platformMemory)) {
    platformMemory = pruned;
    prefs.set('platformSlots', pruned);
  }
}

function renderStatus() {
  clear(els.status);
  const portfolio = state.portfolio;
  if (state.refreshing) {
    els.status.append(h('span', {}, t('Mise à jour des cours…', 'Updating prices…')));
  } else if (portfolio?.lastRefreshAt) {
    els.status.append(h('span', {
      title: t(`Dernière mise à jour : ${fmtDateTimeLong(portfolio.lastRefreshAt)}`,
        `Last update: ${fmtDateTimeLong(portfolio.lastRefreshAt)}`),
    }, t(`Cours mis à jour ${fmtRelative(portfolio.lastRefreshAt)}`, `Prices updated ${fmtRelative(portfolio.lastRefreshAt)}`)));
  } else if (portfolio) {
    els.status.append(h('span', {}, t('Cours pas encore actualisés', 'Prices not refreshed yet')));
  }
  const errors = state.refreshErrors;
  if (errors.length) {
    const generic = errors.length === 1 && !errors[0].name;
    els.status.append(h('span', {
      class: 'status-warn',
      title: errors.map((error) => (error.name
        ? `${tName(error.name)}${t(' : ', ': ')}${tServer(error.message)}`
        : tServer(error.message))).join('\n'),
    }, icon('alert', { size: 14 }), generic
      ? t('Mise à jour impossible', 'Update failed')
      : t(`${errors.length} cours indisponible${errors.length > 1 ? 's' : ''}`,
        `${errors.length} price${errors.length > 1 ? 's' : ''} unavailable`)));
  }
  els.refreshBtn.disabled = state.refreshing;
  refreshIcon?.classList.toggle('is-spinning', state.refreshing);
}

function changeText(amount, ratio) {
  return isNum(ratio) ? `${fmtUsdSigned(amount)} (${fmtRatioChange(ratio)})` : fmtUsdSigned(amount);
}

function renderHero(view) {
  const totals = view.totals;
  clear(els.hero);
  els.hero.append(
    h('div', { class: 'hero-label' }, t('Valeur totale du portefeuille', 'Total portfolio value')),
    h('div', { class: 'hero-value' }, view.loading ? '…' : fmtUsd(totals.valueUsd)));
  if (view.loading) return;
  if (!totals.count) {
    els.hero.append(h('div', { class: 'hero-meta' },
      state.loadFailed
        ? t('Impossible de charger le portefeuille.', 'Unable to load the portfolio.')
        : t('Aucun actif déclaré pour le moment.', 'No assets declared yet.')));
    return;
  }
  els.hero.append(h('div', { class: 'hero-deltas' },
    h('span', {}, delta(totals.pnlUsd, changeText(totals.pnlUsd, totals.pnlPct)), ' ',
      h('span', { class: 'muted' }, t("depuis l'achat", 'since purchase'))),
    h('span', {}, delta(totals.dayChangeUsd, changeText(totals.dayChangeUsd, totals.dayChangePct)), ' ',
      h('span', { class: 'muted' }, t('sur la journée', 'today')))));
  const meta = [
    t(`Valeur initiale ${fmtUsd(totals.initialValueUsd)}`, `Initial value ${fmtUsd(totals.initialValueUsd)}`),
    fmtCount(totals.count, t('actif', 'asset')),
    fmtCount(totals.locations, t('lieu de détention', 'holding location'), t('lieux de détention', 'holding locations')),
  ];
  if (totals.pricedCount < totals.count) {
    meta.push(t(`${totals.count - totals.pricedCount} sans cours`, `${totals.count - totals.pricedCount} without price`));
  }
  els.hero.append(h('div', { class: 'hero-meta' }, meta.join(' · ')));
}

// ------------------------------------------------------------------ thème

function currentTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function renderThemeButton() {
  const dark = currentTheme() === 'dark';
  els.themeIcon.replaceChildren(icon(dark ? 'sun' : 'moon'));
  els.themeBtn.setAttribute('aria-label', dark
    ? t('Passer au thème clair', 'Switch to light theme')
    : t('Passer au thème sombre', 'Switch to dark theme'));
  els.themeBtn.title = dark ? t('Thème clair', 'Light theme') : t('Thème sombre', 'Dark theme');
}

// ------------------------------------------------------------------ langue

function renderLangButton() {
  // Le bouton affiche la langue vers laquelle il bascule.
  els.langBtn.textContent = isEn ? 'FR' : 'EN';
  els.langBtn.lang = isEn ? 'fr' : 'en';
}

// ------------------------------------------------------------------ démarrage

function wireEvents() {
  els.refreshBtn.addEventListener('click', () => refresh());
  els.historyBtn.addEventListener('click', () => historyDialog.open());
  els.langBtn.addEventListener('click', () => setLang(isEn ? 'fr' : 'en'));
  els.themeBtn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    prefs.set('theme', next);
    renderThemeButton();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);

  els.auto.checked = state.autoRefresh;
  els.auto.addEventListener('change', () => {
    state.autoRefresh = els.auto.checked;
    prefs.set('autoRefresh', state.autoRefresh);
    if (state.autoRefresh) refresh({ silent: true });
  });

  setInterval(() => {
    if (!state.refreshing) renderStatus();
  }, 10_000);
  setInterval(() => {
    if (state.autoRefresh && document.visibilityState === 'visible') refresh({ silent: true });
  }, AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.autoRefresh) return;
    const last = state.portfolio?.lastRefreshAt ? new Date(state.portfolio.lastRefreshAt).getTime() : 0;
    if (Date.now() - last > AUTO_REFRESH_MS) refresh({ silent: true });
  });

  window.addEventListener('error', (event) => {
    if (/ResizeObserver loop/.test(event.message ?? '')) return; // avertissement bénin du navigateur
    toast(t(`Erreur inattendue : ${event.message}`, `Unexpected error: ${event.message}`), { type: 'error' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason?.message ?? event.reason;
    toast(t(`Erreur inattendue : ${reason}`, `Unexpected error: ${reason}`), { type: 'error' });
  });
}

async function start() {
  wireEvents();
  renderThemeButton();
  renderLangButton();
  render();
  try {
    state.portfolio = await api.portfolio();
  } catch (error) {
    state.loadFailed = true;
    toast(error.message, { type: 'error', timeout: 8000 });
  }
  render();
  if (state.portfolio?.assets.length) refresh({ silent: true });
}

start();
