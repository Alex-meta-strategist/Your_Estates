// Boîte de dialogue « Déclarer un actif » / « Modifier l'actif ».
import { api } from './api.js';
import { append, clear, h } from './dom.js';
import { fmtMoney, fmtPctChange, fmtUsd, fmtUsdPrice, isNum, parseDecimal, toInputValue } from './format.js';
import { LOCALE, t, tCategory, tName, tServer } from './i18n.js';
import { delta } from './ui.js';

export const CATEGORIES = [
  'Action', 'ETF', 'Fonds', 'Obligation', 'Crypto', 'Matière première', 'Devise', 'Indice',
  'Liquidités', 'Immobilier', 'Private equity', 'Autre',
];
export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD', 'SGD', 'SEK', 'NOK',
  'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'BRL', 'MXN', 'INR', 'KRW', 'ZAR', 'ILS', 'AED',
];
const KINDS = ['market', 'cash', 'manual'];
const DEFAULT_LOCAL_CURRENCY = 'EUR';
const cashName = (currency) => t(`Liquidités ${currency}`, `Cash ${currency}`);

export function createAssetDialog({ onSaved, getLocations }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('asset-dialog');
  const form = $('asset-form');
  const els = {
    title: $('asset-dialog-title'),
    tabs: $('kind-tabs'),
    instrumentField: $('instrument-field'),
    query: $('instrument-query'),
    results: $('instrument-results'),
    picked: $('instrument-picked'),
    cashCurrency: $('cash-currency'),
    manualPrice: $('manual-price'),
    manualCurrency: $('manual-currency'),
    name: $('f-name'),
    quantity: $('f-quantity'),
    quantityLabel: $('f-quantity-label'),
    category: $('f-category'),
    initialField: $('initial-field'),
    initialPrice: $('f-initial-price'),
    initialCurrency: $('f-initial-currency'),
    initialHint: $('initial-hint'),
    location: $('f-location'),
    locations: $('location-options'),
    preview: $('form-preview'),
    error: $('form-error'),
    submit: $('asset-submit'),
  };
  const sections = [...dialog.querySelectorAll('[data-section]')];
  const fxCache = new Map([['USD', 1]]);

  let mode = 'create';
  let kind = 'market';
  let editing = null;
  let picked = null;
  let results = [];
  let activeIndex = -1;
  let searchTimer = 0;
  let searchSeq = 0;
  let searchAbort = null;
  let previewSeq = 0;
  let submitting = false;

  fillOptions(els.category, CATEGORIES, tCategory);
  for (const select of [els.cashCurrency, els.manualCurrency, els.initialCurrency]) fillOptions(select, CURRENCIES);

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (button && mode === 'create' && button.dataset.kind !== kind) setKind(button.dataset.kind);
  });
  els.tabs.addEventListener('keydown', onTabsKeydown);
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // clic sur le fond
  });
  dialog.addEventListener('close', abortSearch);
  els.query.addEventListener('input', onQueryInput);
  els.query.addEventListener('keydown', onQueryKeydown);
  els.query.addEventListener('blur', closeResults);
  els.results.addEventListener('mousedown', (event) => event.preventDefault());
  for (const input of [els.quantity, els.initialPrice, els.manualPrice]) input.addEventListener('input', schedulePreview);
  els.cashCurrency.addEventListener('change', () => {
    if (mode === 'create') els.name.placeholder = cashName(els.cashCurrency.value);
    schedulePreview();
  });
  els.manualCurrency.addEventListener('change', () => {
    if (!els.initialPrice.value.trim()) els.initialCurrency.value = els.manualCurrency.value;
    schedulePreview();
  });
  els.initialCurrency.addEventListener('change', schedulePreview);
  for (const field of form.querySelectorAll('input, select')) {
    field.addEventListener('input', () => {
      field.removeAttribute('aria-invalid');
      hideError();
    });
  }
  form.addEventListener('submit', onSubmit);

  // ------------------------------------------------------------------ ouverture

  function openCreate() {
    mode = 'create';
    editing = null;
    resetForm();
    els.title.textContent = t('Déclarer un actif', 'Declare an asset');
    els.submit.textContent = t("Ajouter l'actif", 'Add asset');
    els.tabs.hidden = false;
    setKind('market');
    dialog.showModal();
    els.query.focus();
  }

  function openEdit(asset) {
    mode = 'edit';
    editing = asset;
    resetForm();
    els.title.textContent = `${t('Modifier', 'Edit')} · ${tName(asset.name)}`;
    els.submit.textContent = t('Enregistrer les modifications', 'Save changes');
    els.tabs.hidden = true;
    setKind(asset.kind);
    els.name.value = asset.name;
    setCategory(asset.category);
    els.quantity.value = toInputValue(asset.quantity);
    els.location.value = asset.location;
    if (asset.kind === 'market') {
      els.instrumentField.hidden = true;
      picked = {
        readOnly: true,
        result: {
          provider: asset.provider, symbol: asset.symbol, ticker: asset.ticker, name: asset.name,
          type: asset.category, exchange: '',
        },
        quote: isNum(asset.priceUsd)
          ? { price: asset.price, currency: asset.priceCurrency, priceUsd: asset.priceUsd, changePct: asset.changePct }
          : null,
      };
      renderPicked();
    } else if (asset.kind === 'cash') {
      ensureOption(els.cashCurrency, asset.quoteCurrency);
      els.cashCurrency.value = asset.quoteCurrency;
      els.cashCurrency.disabled = true;
    } else {
      els.manualPrice.value = toInputValue(asset.manualPrice);
      ensureOption(els.manualCurrency, asset.quoteCurrency);
      els.manualCurrency.value = asset.quoteCurrency;
    }
    if (asset.kind !== 'cash') {
      els.initialPrice.value = toInputValue(asset.initialUnitPrice);
      ensureOption(els.initialCurrency, asset.initialCurrency);
      els.initialCurrency.value = asset.initialCurrency;
      els.initialHint.textContent = t("Prix moyen d'achat par unité ; sert à calculer la valeur initiale.",
        'Average purchase price per unit; used to compute the initial value.');
    }
    dialog.showModal();
    els.quantity.focus();
    els.quantity.select();
    schedulePreview();
  }

  function resetForm() {
    form.reset();
    abortSearch();
    clearTimeout(searchTimer);
    picked = null;
    results = [];
    activeIndex = -1;
    closeResults();
    renderPicked();
    els.instrumentField.hidden = false;
    els.cashCurrency.disabled = false;
    els.cashCurrency.value = DEFAULT_LOCAL_CURRENCY;
    els.manualCurrency.value = DEFAULT_LOCAL_CURRENCY;
    els.initialCurrency.value = 'USD';
    els.initialPrice.placeholder = '';
    for (const field of form.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
    hideError();
    clear(els.preview);
    const locations = [...new Set(getLocations().filter(Boolean))].sort((a, b) => a.localeCompare(b, LOCALE));
    els.locations.replaceChildren(...locations.map((location) => h('option', { value: location })));
  }

  function setKind(next) {
    kind = next;
    for (const button of els.tabs.querySelectorAll('[data-kind]')) {
      const on = button.dataset.kind === next;
      button.setAttribute('aria-checked', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
    }
    for (const section of sections) section.hidden = section.dataset.section !== next;
    els.quantityLabel.textContent = next === 'cash' ? t('Montant', 'Amount') : t('Quantité', 'Quantity');
    const example = t('ex.', 'e.g.');
    els.quantity.placeholder = `${example} ${next === 'cash' ? t('15 000', '15,000') : next === 'manual' ? '1' : '10'}`;
    els.initialField.hidden = next === 'cash';
    if (mode === 'create') {
      picked = null;
      renderPicked();
      els.instrumentField.hidden = false;
      els.name.value = '';
      els.initialPrice.value = '';
      if (next === 'market') {
        els.name.placeholder = t("Rempli automatiquement d'après l'instrument", 'Filled in automatically from the instrument');
        els.initialPrice.placeholder = '';
        els.initialHint.textContent = t('Sert à calculer la valeur initiale. Prérempli avec le cours actuel.',
          'Used to compute the initial value. Prefilled with the current price.');
        setCategory('Action');
      } else if (next === 'cash') {
        els.name.placeholder = cashName(els.cashCurrency.value);
        setCategory('Liquidités');
      } else {
        els.name.placeholder = t('ex. Appartement Lyon', 'e.g. Lyon apartment');
        els.initialPrice.placeholder = t('Valeur actuelle par défaut', 'Current value by default');
        els.initialCurrency.value = els.manualCurrency.value;
        els.initialHint.textContent = t("Laissez vide si la valeur d'achat est égale à la valeur actuelle.",
          'Leave empty if the purchase value equals the current value.');
        if (!els.quantity.value) els.quantity.value = '1';
        setCategory('Immobilier');
      }
    }
    hideError();
    schedulePreview();
  }

  function onTabsKeydown(event) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const index = KINDS.indexOf(kind);
    const next = KINDS[(index + (forward ? 1 : -1) + KINDS.length) % KINDS.length];
    setKind(next);
    els.tabs.querySelector(`[data-kind="${next}"]`).focus();
  }

  // ------------------------------------------------------------------ recherche d'instrument

  function onQueryInput() {
    clearTimeout(searchTimer);
    activeIndex = -1;
    const text = els.query.value.trim();
    if (text.length < 2) {
      abortSearch();
      results = [];
      closeResults();
      return;
    }
    renderResults({ loading: true });
    searchTimer = setTimeout(() => runSearch(text), 300);
  }

  async function runSearch(text) {
    abortSearch();
    const seq = ++searchSeq;
    searchAbort = new AbortController();
    try {
      const data = await api.search(text, searchAbort.signal);
      if (seq !== searchSeq) return;
      results = data.results ?? [];
      renderResults({ errors: (data.errors ?? []).map(tServer) });
    } catch (error) {
      if (error.name === 'AbortError' || seq !== searchSeq) return;
      results = [];
      renderResults({ message: error.message });
    }
  }

  function abortSearch() {
    searchAbort?.abort();
    searchAbort = null;
  }

  function onQueryKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderResults();
    } else if (event.key === 'Enter') {
      event.preventDefault(); // ne jamais soumettre le formulaire depuis la recherche
      const target = results[activeIndex] ?? results[0];
      if (target && !els.results.hidden) pick(target);
    } else if (event.key === 'Escape' && !els.results.hidden) {
      event.preventDefault();
      closeResults();
    }
  }

  function renderResults({ loading = false, errors = [], message = '' } = {}) {
    clear(els.results);
    if (loading) {
      els.results.append(h('li', { class: 'search-message' }, t('Recherche…', 'Searching…')));
    } else if (message) {
      els.results.append(h('li', { class: 'search-message' }, message));
    } else if (!results.length) {
      els.results.append(h('li', { class: 'search-message' }, errors.length
        ? errors.join(' ')
        : t('Aucun instrument trouvé. Essayez le ticker exact (ex. MC.PA, CW8.PA) ou un code ISIN.',
          'No instrument found. Try the exact ticker (e.g. MC.PA, CW8.PA) or an ISIN code.')));
    } else {
      let group = null;
      results.forEach((result, index) => {
        const resultGroup = result.provider === 'coingecko' ? 'Crypto · CoinGecko' : t('Bourse · Yahoo Finance', 'Stocks · Yahoo Finance');
        if (resultGroup !== group) {
          group = resultGroup;
          els.results.append(h('li', { class: 'search-group', role: 'presentation' }, group));
        }
        const active = index === activeIndex;
        const option = h('li', {
          id: `instrument-option-${index}`,
          role: 'option',
          class: `result-option${active ? ' is-active' : ''}`,
          'aria-selected': active ? 'true' : 'false',
        },
          h('div', { class: 'result-top' },
            h('span', { class: 'result-ticker' }, result.ticker || result.symbol),
            h('span', { class: 'result-name' }, result.name)),
          h('span', { class: 'badge' }, tCategory(result.type)),
          h('div', { class: 'result-meta' },
            [result.symbol !== result.ticker ? result.symbol : null, result.exchange].filter(Boolean).join(' · ')));
        option.addEventListener('click', () => pick(result));
        els.results.append(option);
      });
      if (errors.length) els.results.append(h('li', { class: 'search-message' }, errors.join(' ')));
    }
    els.results.hidden = false;
    els.query.setAttribute('aria-expanded', 'true');
    if (activeIndex >= 0) {
      els.query.setAttribute('aria-activedescendant', `instrument-option-${activeIndex}`);
      document.getElementById(`instrument-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
    } else {
      els.query.removeAttribute('aria-activedescendant');
    }
  }

  function closeResults() {
    els.results.hidden = true;
    els.query.setAttribute('aria-expanded', 'false');
    els.query.removeAttribute('aria-activedescendant');
  }

  async function pick(result) {
    const current = { result, quote: null, loading: true, error: null };
    picked = current;
    closeResults();
    els.query.value = '';
    els.instrumentField.hidden = true;
    els.name.value = result.name;
    setCategory(result.category);
    renderPicked();
    try {
      const { quote } = await api.quote(result.provider, result.symbol);
      if (picked !== current) return;
      current.quote = quote;
      ensureOption(els.initialCurrency, quote.currency);
      els.initialCurrency.value = quote.currency;
      els.initialPrice.value = toInputValue(quote.price);
      if (!els.name.value && quote.name) els.name.value = quote.name;
    } catch (error) {
      if (picked !== current) return;
      current.error = error.message;
    }
    current.loading = false;
    renderPicked();
    schedulePreview();
    if (!current.error) els.quantity.focus();
  }

  function unpick() {
    picked = null;
    renderPicked();
    els.instrumentField.hidden = false;
    els.initialPrice.value = '';
    els.name.value = '';
    schedulePreview();
    els.query.focus();
  }

  function renderPicked() {
    clear(els.picked);
    if (!picked) {
      els.picked.hidden = true;
      return;
    }
    const { result, quote, loading, error, readOnly } = picked;
    let price = null;
    if (loading) price = h('div', { class: 'picked-meta' }, t('Récupération du cours…', 'Fetching price…'));
    else if (error) price = h('div', { class: 'picked-error' }, error);
    else if (quote) {
      price = h('div', { class: 'picked-price' }, t('Cours actuel : ', 'Current price: '),
        h('strong', {}, fmtMoney(quote.price, quote.currency)),
        quote.currency !== 'USD' ? ` (${fmtUsdPrice(quote.priceUsd)})` : '',
        isNum(quote.changePct) ? [' ', delta(quote.changePct, fmtPctChange(quote.changePct))] : null);
    }
    const source = result.provider === 'coingecko' ? 'CoinGecko' : 'Yahoo Finance';
    append(els.picked, [
      h('div', { class: 'picked-body' },
        h('div', { class: 'picked-title' }, `${result.ticker || result.symbol} · ${tName(result.name)}`),
        h('div', { class: 'picked-meta' }, [tCategory(result.type), result.exchange, source].filter(Boolean).join(' · ')),
        price),
      readOnly ? null : h('button', { type: 'button', class: 'btn btn-sm', onclick: unpick }, t('Changer', 'Change')),
    ]);
    els.picked.hidden = false;
  }

  // ------------------------------------------------------------------ aperçu des valeurs

  function schedulePreview() {
    const seq = ++previewSeq;
    computePreview()
      .then((preview) => {
        if (seq === previewSeq) renderPreview(preview);
      })
      .catch(() => {});
  }

  async function getFx(currency) {
    if (fxCache.has(currency)) return fxCache.get(currency);
    try {
      const { usd } = await api.fx(currency);
      fxCache.set(currency, usd);
      return usd;
    } catch {
      return null;
    }
  }

  async function initialFx(currency, quote) {
    if (mode === 'edit' && currency === editing.initialCurrency) return editing.initialFxUsd;
    if (quote && currency === quote.currency && quote.price > 0) return quote.priceUsd / quote.price;
    return getFx(currency);
  }

  async function computePreview() {
    const quantity = parseDecimal(els.quantity.value);
    if (!(quantity > 0)) return null;
    let current = null;
    let initial = null;
    if (kind === 'market') {
      const quote = picked?.quote;
      if (quote && isNum(quote.priceUsd)) current = quantity * quote.priceUsd;
      const price = parseDecimal(els.initialPrice.value);
      if (price >= 0) {
        const fx = await initialFx(els.initialCurrency.value, quote);
        if (isNum(fx)) initial = quantity * price * fx;
      }
    } else if (kind === 'cash') {
      const fx = await getFx(els.cashCurrency.value);
      if (isNum(fx)) current = quantity * fx;
      initial = mode === 'edit' ? quantity * editing.initialFxUsd : current;
    } else {
      const price = parseDecimal(els.manualPrice.value);
      const fx = await getFx(els.manualCurrency.value);
      if (price >= 0 && isNum(fx)) current = quantity * price * fx;
      const raw = els.initialPrice.value.trim();
      if (!raw) {
        initial = current;
      } else {
        const initialPrice = parseDecimal(raw);
        const ifx = await initialFx(els.initialCurrency.value, null);
        if (initialPrice >= 0 && isNum(ifx)) initial = quantity * initialPrice * ifx;
      }
    }
    return { current, initial };
  }

  function renderPreview(preview) {
    clear(els.preview);
    if (!preview) return;
    const parts = [];
    if (isNum(preview.current)) parts.push([t('Valeur actuelle ≈ ', 'Current value ≈ '), h('strong', {}, fmtUsd(preview.current))]);
    if (isNum(preview.initial)) parts.push([t('Valeur initiale ≈ ', 'Initial value ≈ '), h('strong', {}, fmtUsd(preview.initial))]);
    parts.forEach((part, index) => {
      if (index) els.preview.append(' · ');
      append(els.preview, part);
    });
  }

  // ------------------------------------------------------------------ enregistrement

  function fail(field, message) {
    const problem = new Error(message);
    problem.field = field;
    throw problem;
  }

  function collect() {
    const quantity = parseDecimal(els.quantity.value);
    if (!(quantity > 0)) {
      fail(els.quantity, kind === 'cash'
        ? t('Indiquez un montant strictement positif.', 'Enter a strictly positive amount.')
        : t('Indiquez une quantité strictement positive.', 'Enter a strictly positive quantity.'));
    }
    const location = els.location.value.trim();
    const name = els.name.value.trim();
    const category = els.category.value;

    if (mode === 'edit') {
      if (!name) fail(els.name, t('Le nom ne peut pas être vide.', 'The name cannot be empty.'));
      if (!location) fail(els.location, t('Indiquez le lieu de détention (banque, courtier, wallet…).', 'Enter the holding location (bank, broker, wallet…).'));
      const payload = { name, category, quantity, location };
      if (kind !== 'cash') {
        const initialPrice = parseDecimal(els.initialPrice.value);
        if (!(initialPrice >= 0)) fail(els.initialPrice, t("Indiquez un prix d'achat valide.", 'Enter a valid purchase price.'));
        payload.initialUnitPrice = initialPrice;
        payload.initialCurrency = els.initialCurrency.value;
      }
      if (kind === 'manual') {
        const manualPrice = parseDecimal(els.manualPrice.value);
        if (!(manualPrice >= 0)) fail(els.manualPrice, t('Indiquez la valeur unitaire actuelle.', 'Enter the current unit value.'));
        payload.manualPrice = manualPrice;
        payload.currency = els.manualCurrency.value;
      }
      return payload;
    }

    if (kind === 'market') {
      if (!picked) fail(els.query, t('Choisissez un instrument dans la liste de résultats.', 'Choose an instrument from the results list.'));
      if (!picked.quote) {
        fail(els.quantity, picked.loading
          ? t('Cours en cours de récupération, un instant…', 'Fetching the price, one moment…')
          : t('Cours indisponible pour cet instrument.', 'Price unavailable for this instrument.'));
      }
      const initialPrice = parseDecimal(els.initialPrice.value);
      if (!(initialPrice >= 0)) fail(els.initialPrice, t("Indiquez un prix d'achat valide.", 'Enter a valid purchase price.'));
      if (!location) fail(els.location, t('Indiquez le lieu de détention (banque, courtier, wallet…).', 'Enter the holding location (bank, broker, wallet…).'));
      return {
        kind,
        provider: picked.result.provider,
        symbol: picked.result.symbol,
        ticker: picked.quote.ticker || picked.result.ticker,
        name: name || picked.result.name,
        category,
        quantity,
        initialUnitPrice: initialPrice,
        initialCurrency: els.initialCurrency.value,
        location,
      };
    }
    if (kind === 'cash') {
      if (!location) fail(els.location, t('Indiquez où sont détenues ces liquidités (banque, courtier…).', 'Enter where this cash is held (bank, broker…).'));
      // Nom vide : le serveur enregistre le nom par défaut « Liquidités XXX », affiché traduit.
      return { kind, currency: els.cashCurrency.value, name, category, quantity, location };
    }
    if (!name) fail(els.name, t('Donnez un nom à cet actif.', 'Give this asset a name.'));
    const manualPrice = parseDecimal(els.manualPrice.value);
    if (!(manualPrice >= 0)) fail(els.manualPrice, t('Indiquez la valeur unitaire actuelle.', 'Enter the current unit value.'));
    const raw = els.initialPrice.value.trim();
    const initialPrice = raw ? parseDecimal(raw) : manualPrice;
    if (!(initialPrice >= 0)) {
      fail(els.initialPrice, t("Indiquez un prix d'achat valide, ou laissez le champ vide.", 'Enter a valid purchase price, or leave the field empty.'));
    }
    if (!location) fail(els.location, t('Indiquez le lieu de détention.', 'Enter the holding location.'));
    return {
      kind,
      name,
      category,
      currency: els.manualCurrency.value,
      manualPrice,
      quantity,
      initialUnitPrice: initialPrice,
      initialCurrency: raw ? els.initialCurrency.value : els.manualCurrency.value,
      location,
    };
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    hideError();
    let payload;
    try {
      payload = collect();
    } catch (problem) {
      showError(problem.message, problem.field);
      return;
    }
    submitting = true;
    const label = els.submit.textContent;
    els.submit.disabled = true;
    els.submit.textContent = t('Enregistrement…', 'Saving…');
    try {
      const response = mode === 'create'
        ? await api.createAsset(payload)
        : await api.updateAsset(editing.id, payload);
      dialog.close();
      onSaved(response, mode);
    } catch (error) {
      showError(error.message);
    } finally {
      submitting = false;
      els.submit.disabled = false;
      els.submit.textContent = label;
    }
  }

  function showError(message, field) {
    els.error.textContent = message;
    els.error.hidden = false;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }

  function hideError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  function setCategory(value) {
    ensureOption(els.category, value);
    els.category.value = value;
  }

  return { openCreate, openEdit };
}

function fillOptions(select, values, label = (value) => value) {
  select.replaceChildren(...values.map((value) => h('option', { value }, label(value))));
}

function ensureOption(select, value) {
  if (value && ![...select.options].some((option) => option.value === value)) {
    select.append(h('option', { value }, select.id === 'f-category' ? tCategory(value) : value));
  }
}
