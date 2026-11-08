"""Données de marché, sans clé d'API.

* Yahoo Finance : actions, ETF, fonds, indices, devises, matières premières, cryptos ;
* CoinGecko : cryptomonnaies, cotées directement en dollars ;
* Frankfurter (taux BCE) : taux de change de secours si Yahoo ne répond pas.

Ces services n'autorisent pas les appels directs depuis un navigateur : c'est le
serveur qui les interroge. Toutes les valeurs sont converties en dollars (USD).
"""
from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
YAHOO_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
COINGECKO_API = "https://api.coingecko.com/api/v3"
FRANKFURTER_API = "https://api.frankfurter.dev/v1/latest"

# Certaines places cotent en sous-unités (pence, cents, agorot) : devise -> (devise principale, facteur).
MINOR_UNITS: dict[str, tuple[str, float]] = {
    "GBp": ("GBP", 0.01),
    "GBX": ("GBP", 0.01),
    "ZAc": ("ZAR", 0.01),
    "ZAC": ("ZAR", 0.01),
    "ILA": ("ILS", 0.01),
    "USX": ("USD", 0.01),
}

# quoteType Yahoo -> (catégorie de l'actif, libellé du type d'instrument)
YAHOO_TYPES: dict[str, tuple[str, str]] = {
    "EQUITY": ("Action", "Action"),
    "ETF": ("ETF", "ETF"),
    "MUTUALFUND": ("Fonds", "Fonds"),
    "MONEYMARKET": ("Fonds", "Monétaire"),
    "CRYPTOCURRENCY": ("Crypto", "Crypto"),
    "INDEX": ("Indice", "Indice"),
    "CURRENCY": ("Devise", "Devise"),
    "FUTURE": ("Matière première", "Contrat à terme"),
}

FetchJson = Callable[[str, dict[str, str]], Any]


class MarketError(Exception):
    """Échec d'accès aux données de marché ; le message s'adresse à l'utilisateur."""

    def __init__(self, message: str, *, not_found: bool = False) -> None:
        super().__init__(message)
        self.not_found = not_found


@dataclass
class Quote:
    provider: str
    symbol: str
    price: float  # dans la devise de cotation ``currency``
    currency: str
    price_usd: float
    change_pct: float | None = None  # variation sur la journée (ou 24 h pour les cryptos), en %
    market_time: str | None = None
    name: str | None = None
    instrument_type: str | None = None
    exchange: str | None = None

    def as_record(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "symbol": self.symbol,
            "price": self.price,
            "currency": self.currency,
            "price_usd": self.price_usd,
            "change_pct": self.change_pct,
            "market_time": self.market_time,
        }


def category_for_type(instrument_type: str | None) -> str:
    return YAHOO_TYPES.get((instrument_type or "").upper(), ("Autre", "Autre"))[0]


def yahoo_ticker(symbol: str, instrument_type: str | None) -> str:
    """Code court affiché comme unité : BTC-USD -> BTC, EURUSD=X -> EURUSD."""
    kind = (instrument_type or "").upper()
    if kind == "CRYPTOCURRENCY" and "-" in symbol:
        return symbol.split("-", 1)[0]
    if kind == "CURRENCY" and symbol.endswith("=X"):
        return symbol[:-2]
    return symbol


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _iso_from_epoch(value: Any) -> str | None:
    if not _is_number(value):
        return None
    moment = datetime.fromtimestamp(value, tz=timezone.utc)
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


class MarketData:
    def __init__(
        self,
        *,
        coingecko_api_key: str | None = None,
        timeout: float = 10.0,
        fx_ttl: float = 60.0,
        fetch_json: FetchJson | None = None,
    ) -> None:
        self.timeout = timeout
        self.fx_ttl = fx_ttl
        self.coingecko_api_key = coingecko_api_key
        self._fetch_json: FetchJson = fetch_json or self._http_get_json
        self._fx_cache: dict[str, tuple[float, float, float | None]] = {}
        self._fx_locks: dict[str, threading.Lock] = {}
        self._fx_guard = threading.Lock()

    # ------------------------------------------------------------------ HTTP

    def _http_get_json(self, url: str, headers: dict[str, str]) -> Any:
        request_headers = {"User-Agent": USER_AGENT, "Accept": "application/json", **headers}
        attempts = 2
        for attempt in range(attempts):
            request = urllib.request.Request(url, headers=request_headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    raise MarketError("ressource introuvable", not_found=True) from error
                if error.code in (429, 500, 502, 503, 504) and attempt + 1 < attempts:
                    time.sleep(0.8)
                    continue
                if error.code == 429:
                    raise MarketError("trop de requêtes, réessayez dans une minute") from error
                raise MarketError(f"erreur HTTP {error.code}") from error
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if attempt + 1 < attempts:
                    time.sleep(0.4)
                    continue
                raise MarketError("service injoignable (connexion Internet ?)") from error
            except (ValueError, UnicodeDecodeError) as error:
                raise MarketError("réponse illisible du service") from error
        raise MarketError("service injoignable")

    # ------------------------------------------------------------------ cotations

    def quote(self, provider: str, symbol: str) -> Quote:
        if provider == "yahoo":
            return self.yahoo_quote(symbol)
        if provider == "coingecko":
            return self.coingecko_quote(symbol)
        if provider == "fx":
            return self.cash_quote(symbol)
        raise MarketError(f"Fournisseur de cours inconnu : {provider}.")

    def quotes(self, keys: Iterable[tuple[str, str]], max_workers: int = 6) -> dict[tuple[str, str], Quote | MarketError]:
        """Cotations de plusieurs instruments en parallèle ; un échec n'empêche pas les autres."""
        wanted = sorted(set(keys))
        results: dict[tuple[str, str], Quote | MarketError] = {}
        coins = [symbol for provider, symbol in wanted if provider == "coingecko"]
        singles = [key for key in wanted if key[0] != "coingecko"]
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            coin_future = pool.submit(self.coingecko_quotes, coins) if coins else None
            futures = {key: pool.submit(self._safe_quote, *key) for key in singles}
            for key, future in futures.items():
                results[key] = future.result()
            if coin_future is not None:
                for coin, result in coin_future.result().items():
                    results[("coingecko", coin)] = result
        return results

    def _safe_quote(self, provider: str, symbol: str) -> Quote | MarketError:
        try:
            return self.quote(provider, symbol)
        except MarketError as error:
            return error
        except Exception as error:  # ne jamais faire échouer tout le rafraîchissement
            return MarketError(f"Erreur inattendue pour {symbol} : {error}")

    def _yahoo_meta(self, symbol: str) -> dict[str, Any]:
        encoded = urllib.parse.quote(symbol, safe="")
        last_error: MarketError | None = None
        for host in YAHOO_HOSTS:
            url = f"https://{host}/v8/finance/chart/{encoded}?range=1d&interval=1d"
            try:
                payload = self._fetch_json(url, {})
            except MarketError as error:
                if error.not_found:
                    raise MarketError(f"Symbole « {symbol} » introuvable sur Yahoo Finance.", not_found=True) from error
                last_error = error
                continue
            results = ((payload or {}).get("chart") or {}).get("result") or []
            if not results:
                raise MarketError(f"Symbole « {symbol} » introuvable sur Yahoo Finance.", not_found=True)
            meta = results[0].get("meta") or {}
            if not _is_number(meta.get("regularMarketPrice")):
                raise MarketError(f"Aucun cours disponible pour « {symbol} » sur Yahoo Finance.")
            return meta
        raise MarketError(f"Yahoo Finance ({symbol}) : {last_error}.")

    def yahoo_quote(self, symbol: str) -> Quote:
        meta = self._yahoo_meta(symbol)
        price = float(meta["regularMarketPrice"])
        currency = str(meta.get("currency") or "USD")
        change = meta.get("regularMarketChangePercent")
        if not _is_number(change):
            previous = meta.get("chartPreviousClose") or meta.get("previousClose")
            change = (price / previous - 1.0) * 100.0 if _is_number(previous) and previous else None
        name = (meta.get("longName") or meta.get("shortName") or "").strip() or None
        return Quote(
            provider="yahoo",
            symbol=symbol,
            price=price,
            currency=currency,
            price_usd=price * self.fx_to_usd(currency),
            change_pct=float(change) if change is not None else None,
            market_time=_iso_from_epoch(meta.get("regularMarketTime")),
            name=name,
            instrument_type=meta.get("instrumentType"),
            exchange=meta.get("fullExchangeName") or meta.get("exchangeName"),
        )

    def _coingecko_headers(self) -> dict[str, str]:
        return {"x-cg-demo-api-key": self.coingecko_api_key} if self.coingecko_api_key else {}

    def coingecko_quotes(self, coin_ids: Iterable[str]) -> dict[str, Quote | MarketError]:
        ids = sorted(set(coin_ids))
        results: dict[str, Quote | MarketError] = {}
        for start in range(0, len(ids), 100):
            chunk = ids[start:start + 100]
            query = urllib.parse.urlencode({
                "ids": ",".join(chunk),
                "vs_currencies": "usd",
                "include_24hr_change": "true",
                "include_last_updated_at": "true",
            })
            try:
                payload = self._fetch_json(f"{COINGECKO_API}/simple/price?{query}", self._coingecko_headers())
            except MarketError as error:
                for coin in chunk:
                    results[coin] = MarketError(f"CoinGecko ({coin}) : {error}.")
                continue
            for coin in chunk:
                row = payload.get(coin) if isinstance(payload, dict) else None
                price = row.get("usd") if isinstance(row, dict) else None
                if not _is_number(price):
                    results[coin] = MarketError(f"Crypto « {coin} » introuvable sur CoinGecko.", not_found=True)
                    continue
                change = row.get("usd_24h_change")
                results[coin] = Quote(
                    provider="coingecko",
                    symbol=coin,
                    price=float(price),
                    currency="USD",
                    price_usd=float(price),
                    change_pct=float(change) if _is_number(change) else None,
                    market_time=_iso_from_epoch(row.get("last_updated_at")),
                    instrument_type="CRYPTOCURRENCY",
                )
        return results

    def coingecko_quote(self, coin_id: str) -> Quote:
        result = self.coingecko_quotes([coin_id])[coin_id]
        if isinstance(result, MarketError):
            raise result
        return result

    def cash_quote(self, currency: str) -> Quote:
        """Liquidités : une unité de la devise, valorisée au taux de change du moment."""
        code = currency.strip().upper()
        rate, change = self._fx(code)
        return Quote(
            provider="fx",
            symbol=code,
            price=1.0,
            currency=code,
            price_usd=rate,
            change_pct=change,
            name=f"Liquidités {code}",
            instrument_type="CASH",
        )

    # ------------------------------------------------------------------ change

    def fx_to_usd(self, currency: str) -> float:
        """Combien de dollars vaut une unité de ``currency``."""
        return self._fx(currency)[0]

    def _fx(self, currency: str) -> tuple[float, float | None]:
        code = (currency or "USD").strip()
        if code in MINOR_UNITS:
            major, factor = MINOR_UNITS[code]
            rate, change = self._fx(major)
            return rate * factor, change
        code = code.upper()
        if code == "USD":
            return 1.0, None
        with self._fx_guard:
            lock = self._fx_locks.setdefault(code, threading.Lock())
        with lock:  # une seule requête par devise, même si plusieurs cotations la demandent en même temps
            cached = self._fx_cache.get(code)
            if cached and time.monotonic() - cached[1] < self.fx_ttl:
                return cached[0], cached[2]
            try:
                rate, change = self._fetch_fx(code)
            except MarketError:
                if cached:  # mieux vaut un taux un peu ancien que pas de valorisation du tout
                    return cached[0], cached[2]
                raise
            self._fx_cache[code] = (rate, time.monotonic(), change)
            return rate, change

    def _fetch_fx(self, code: str) -> tuple[float, float | None]:
        try:
            meta = self._yahoo_meta(f"{code}USD=X")
            rate = float(meta["regularMarketPrice"])
            if rate > 0:
                change = meta.get("regularMarketChangePercent")
                return rate, float(change) if _is_number(change) else None
        except MarketError:
            pass
        try:
            query = urllib.parse.urlencode({"base": "USD", "symbols": code})
            payload = self._fetch_json(f"{FRANKFURTER_API}?{query}", {})
            per_usd = ((payload or {}).get("rates") or {}).get(code)
            if _is_number(per_usd) and per_usd > 0:
                return 1.0 / per_usd, None
        except MarketError:
            pass
        raise MarketError(f"Taux de change {code} -> USD indisponible.")

    # ------------------------------------------------------------------ recherche

    def search(self, text: str, limit: int = 8) -> dict[str, Any]:
        """Recherche d'instruments sur Yahoo Finance et CoinGecko, en parallèle."""
        with ThreadPoolExecutor(max_workers=2) as pool:
            yahoo_future = pool.submit(self._guard, self._yahoo_search, text, limit)
            coin_future = pool.submit(self._guard, self._coingecko_search, text, 6)
            yahoo, coins = yahoo_future.result(), coin_future.result()
        errors: list[str] = []
        if isinstance(yahoo, MarketError):
            errors.append(str(yahoo))
            yahoo = []
        if isinstance(coins, MarketError):
            errors.append(str(coins))
            coins = []
        if coins:  # pour les cryptos, CoinGecko est la source de référence
            yahoo = [item for item in yahoo if item["category"] != "Crypto"]
        # « bitcoin » doit d'abord proposer la crypto, pas les contrats à terme Yahoo.
        if self._exact_match(coins, text) and not self._exact_match(yahoo, text):
            return {"results": coins + yahoo, "errors": errors}
        return {"results": yahoo + coins, "errors": errors}

    @staticmethod
    def _exact_match(results: list[dict[str, Any]], text: str) -> bool:
        needle = text.strip().lower()
        return any(needle in (item["ticker"].lower(), item["name"].lower(), item["symbol"].lower()) for item in results)

    @staticmethod
    def _guard(function: Callable[..., Any], *args: Any) -> Any:
        try:
            return function(*args)
        except MarketError as error:
            return error
        except Exception as error:
            return MarketError(f"Recherche impossible : {error}")

    def _yahoo_search(self, text: str, limit: int) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"q": text, "quotesCount": limit, "newsCount": 0, "listsCount": 0})
        payload = None
        last_error: MarketError | None = None
        for host in reversed(YAHOO_HOSTS):
            try:
                payload = self._fetch_json(f"https://{host}/v1/finance/search?{query}", {})
                break
            except MarketError as error:
                last_error = error
        if payload is None:
            raise MarketError(f"Recherche Yahoo Finance indisponible : {last_error}.")
        results = []
        for item in (payload or {}).get("quotes") or []:
            symbol = item.get("symbol")
            quote_type = (item.get("quoteType") or "").upper()
            if not symbol or quote_type not in YAHOO_TYPES:
                continue
            category, type_label = YAHOO_TYPES[quote_type]
            results.append({
                "provider": "yahoo",
                "symbol": symbol,
                "ticker": yahoo_ticker(symbol, quote_type),
                "name": (item.get("longname") or item.get("shortname") or symbol).strip(),
                "exchange": item.get("exchDisp") or item.get("exchange") or "",
                "type": type_label,
                "category": category,
            })
        return results

    def _coingecko_search(self, text: str, limit: int) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"query": text})
        try:
            payload = self._fetch_json(f"{COINGECKO_API}/search?{query}", self._coingecko_headers())
        except MarketError as error:
            raise MarketError(f"Recherche CoinGecko indisponible : {error}.") from error
        results = []
        for coin in ((payload or {}).get("coins") or [])[:limit]:
            coin_id = coin.get("id")
            if not coin_id:
                continue
            rank = coin.get("market_cap_rank")
            results.append({
                "provider": "coingecko",
                "symbol": coin_id,
                "ticker": (coin.get("symbol") or coin_id).upper(),
                "name": coin.get("name") or coin_id,
                "exchange": f"CoinGecko · rang #{rank}" if rank else "CoinGecko",
                "type": "Crypto",
                "category": "Crypto",
            })
        return results
