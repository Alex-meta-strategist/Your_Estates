// Client de l'API locale.
import { t, tServer } from './i18n.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, url, { body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Patrimony'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(t("Serveur Your Estates injoignable : vérifiez qu'il est toujours lancé.",
      'Your Estates server unreachable: check that it is still running.'), 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* réponse vide ou non JSON */
  }
  if (!response.ok) throw new ApiError(data?.error ? tServer(data.error) : t(`Erreur ${response.status}`, `Error ${response.status}`), response.status);
  return data;
}

const query = (params) => new URLSearchParams(params).toString();

export const api = {
  portfolio: () => request('GET', '/api/portfolio'),
  refresh: () => request('POST', '/api/refresh', { body: {} }),
  createAsset: (payload) => request('POST', '/api/assets', { body: payload }),
  updateAsset: (id, payload) => request('PUT', `/api/assets/${id}`, { body: payload }),
  deleteAsset: (id) => request('DELETE', `/api/assets/${id}`),
  events: (assetId) => request('GET', `/api/events${assetId ? `?${query({ assetId })}` : ''}`),
  search: (text, signal) => request('GET', `/api/search?${query({ q: text })}`, { signal }),
  quote: (provider, symbol) => request('GET', `/api/quote?${query({ provider, symbol })}`),
  fx: (currency) => request('GET', `/api/fx?${query({ currency })}`),
};
