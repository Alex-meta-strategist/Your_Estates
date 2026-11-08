"""Logique métier : validation des saisies, valorisation du portefeuille, rafraîchissement des cours."""
from __future__ import annotations

import math
import re
import threading
from datetime import datetime, timezone
from typing import Any, Callable

from . import db as repo
from .db import Database
from .market import MINOR_UNITS, MarketData, MarketError, Quote, category_for_type, yahoo_ticker

KINDS = ("market", "cash", "manual")
MARKET_PROVIDERS = ("yahoo", "coingecko")
REFRESH_MIN_INTERVAL = 5  # secondes : en deçà, le dernier cours est réutilisé
PRICE_HISTORY_INTERVAL = 300  # au plus un point d'historique par instrument toutes les 5 minutes

# Colonne SQL -> nom du champ exposé par l'API (et utilisé dans le journal).
API_FIELDS = {
    "kind": "kind",
    "provider": "provider",
    "symbol": "symbol",
    "ticker": "ticker",
    "name": "name",
    "category": "category",
    "quantity": "quantity",
    "quote_currency": "quoteCurrency",
    "manual_price": "manualPrice",
    "initial_unit_price": "initialUnitPrice",
    "initial_currency": "initialCurrency",
    "initial_fx_usd": "initialFxUsd",
    "location": "location",
    "created_at": "createdAt",
    "updated_at": "updatedAt",
    "archived_at": "archivedAt",
}

_CURRENCY_RE = re.compile(r"^[A-Za-z]{3}$")
_SYMBOL_RE = re.compile(r"^[\^A-Za-z0-9][A-Za-z0-9.\-_=^&]{0,39}$")


class ValidationError(ValueError):
    """Saisie invalide (HTTP 400)."""


class NotFoundError(LookupError):
    """Ressource inconnue (HTTP 404)."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def from_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# --------------------------------------------------------------------------- validation

def parse_number(value: Any, label: str, *, positive: bool = False, required: bool = True) -> float | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ValidationError(f"{label} : valeur requise.")
        return None
    if isinstance(value, bool):
        raise ValidationError(f"{label} : nombre invalide.")
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        cleaned = value.strip().replace(" ", "").replace(" ", "").replace(" ", "").replace(",", ".")
        try:
            number = float(cleaned)
        except ValueError:
            raise ValidationError(f"{label} : nombre invalide.") from None
    else:
        raise ValidationError(f"{label} : nombre invalide.")
    if not math.isfinite(number):
        raise ValidationError(f"{label} : nombre invalide.")
    if number < 0 or (positive and number == 0):
        raise ValidationError(f"{label} doit être {'strictement positif' if positive else 'positif ou nul'}.")
    if number > 1e15:
        raise ValidationError(f"{label} : valeur trop grande.")
    return number


def clean_text(value: Any, label: str, *, required: bool = False, max_length: int = 120) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValidationError(f"{label} : texte attendu.")
    text = " ".join(value.split())
    if required and not text:
        raise ValidationError(f"{label} : champ requis.")
    if len(text) > max_length:
        raise ValidationError(f"{label} : {max_length} caractères maximum.")
    return text


def parse_currency(value: Any, label: str, *, required: bool = True, allow_minor: bool = True) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ValidationError(f"{label} : devise requise.")
        return None
    if not isinstance(value, str) or not _CURRENCY_RE.match(value.strip()):
        raise ValidationError(f"{label} : code devise invalide (ex. USD, EUR).")
    code = value.strip()
    if allow_minor and code in MINOR_UNITS:
        return code
    return code.upper()


def clean_symbol(value: Any) -> str:
    if not isinstance(value, str) or not _SYMBOL_RE.match(value.strip()):
        raise ValidationError("Symbole d'instrument invalide.")
    return value.strip()


# --------------------------------------------------------------------------- vues

def public_asset(row: dict[str, Any]) -> dict[str, Any]:
    view = {"id": row["id"]}
    for column, field in API_FIELDS.items():
        view[field] = row[column]
    return view


def asset_view(asset: dict[str, Any], quote: dict[str, Any] | None) -> dict[str, Any]:
    quantity = asset["quantity"]
    initial_value = quantity * asset["initial_unit_price"] * asset["initial_fx_usd"]
    price_usd = quote["price_usd"] if quote else None
    value = quantity * price_usd if price_usd is not None else None
    change_pct = quote["change_pct"] if quote else None
    day_change = None
    if value is not None and change_pct is not None and change_pct > -100:
        day_change = value * change_pct / (100.0 + change_pct)
    pnl = value - initial_value if value is not None else None
    view = public_asset(asset)
    view.update({
        "initialValueUsd": initial_value,
        "price": quote["price"] if quote else None,
        "priceCurrency": quote["currency"] if quote else None,
        "priceUsd": price_usd,
        "changePct": change_pct,
        "marketTime": quote["market_time"] if quote else None,
        "quoteUpdatedAt": quote["fetched_at"] if quote else None,
        "quoteError": quote["error"] if quote else None,
        "valueUsd": value,
        "dayChangeUsd": day_change,
        "pnlUsd": pnl,
        "pnlPct": pnl / initial_value if pnl is not None and initial_value > 0 else None,
        "share": 0.0,
    })
    return view


def build_portfolio(
    assets: list[dict[str, Any]],
    quotes: dict[tuple[str, str], dict[str, Any]],
    last_refresh_at: str | None,
) -> dict[str, Any]:
    views = [asset_view(asset, quotes.get((asset["provider"], asset["symbol"]))) for asset in assets]
    priced = [view for view in views if view["valueUsd"] is not None]
    total_value = sum(view["valueUsd"] for view in priced)
    total_initial = sum(view["initialValueUsd"] for view in views)
    priced_initial = sum(view["initialValueUsd"] for view in priced)
    day_change = sum(view["dayChangeUsd"] for view in priced if view["dayChangeUsd"] is not None)
    for view in priced:
        view["share"] = view["valueUsd"] / total_value if total_value > 0 else 0.0
    # Du plus gros au plus petit ; les actifs sans cours en dernier.
    views.sort(key=lambda view: (
        view["valueUsd"] is None,
        -(view["valueUsd"] or 0.0),
        view["name"].lower(),
        view["id"],
    ))
    pnl = total_value - priced_initial
    previous_value = total_value - day_change
    totals = {
        "valueUsd": total_value,
        "initialValueUsd": total_initial,
        "pnlUsd": pnl,
        "pnlPct": pnl / priced_initial if priced_initial > 0 else None,
        "dayChangeUsd": day_change,
        "dayChangePct": day_change / previous_value if previous_value > 0 else None,
        "count": len(views),
        "pricedCount": len(priced),
        "locations": len({view["location"].lower() for view in views if view["location"]}),
    }
    return {"assets": views, "totals": totals, "lastRefreshAt": last_refresh_at}


def quote_view(quote: Quote) -> dict[str, Any]:
    if quote.provider == "yahoo":
        category = category_for_type(quote.instrument_type)
        ticker = yahoo_ticker(quote.symbol, quote.instrument_type)
    elif quote.provider == "coingecko":
        category, ticker = "Crypto", None
    else:
        category, ticker = "Liquidités", quote.symbol
    return {
        "provider": quote.provider,
        "symbol": quote.symbol,
        "ticker": ticker,
        "name": quote.name,
        "category": category,
        "exchange": quote.exchange,
        "price": quote.price,
        "currency": quote.currency,
        "priceUsd": quote.price_usd,
        "changePct": quote.change_pct,
        "marketTime": quote.market_time,
    }


# --------------------------------------------------------------------------- service

class PortfolioService:
    def __init__(self, database: Database, market: MarketData, clock: Callable[[], datetime] = utc_now) -> None:
        self.db = database
        self.market = market
        self.clock = clock
        self._refresh_lock = threading.Lock()

    def _now(self) -> str:
        return to_iso(self.clock())

    # ------------------------------------------------------------------ lecture

    def portfolio(self) -> dict[str, Any]:
        with self.db.read() as conn:
            assets = repo.list_assets(conn)
            quotes = repo.get_quotes(conn)
            last_refresh = repo.get_setting(conn, "last_refresh_at")
        return build_portfolio(assets, quotes, last_refresh)

    def events(self, asset_id: int | None = None, limit: int = 300) -> dict[str, Any]:
        limit = max(1, min(int(limit or 300), 1000))
        with self.db.read() as conn:
            events = repo.list_events(conn, asset_id, limit)
            assets = repo.list_assets(conn, include_archived=True)
        return {
            "events": [
                {
                    "id": event["id"],
                    "assetId": event["asset_id"],
                    "type": event["type"],
                    "createdAt": event["created_at"],
                    "changes": event["changes"],
                    "asset": event["snapshot"],
                }
                for event in events
            ],
            "assets": [
                {
                    "id": asset["id"],
                    "name": asset["name"],
                    "ticker": asset["ticker"],
                    "location": asset["location"],
                    "archived": asset["archived_at"] is not None,
                }
                for asset in assets
            ],
        }

    # ------------------------------------------------------------------ écriture

    def create_asset(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValidationError("Requête invalide.")
        kind = payload.get("kind")
        if kind not in KINDS:
            raise ValidationError("Type d'actif inconnu.")
        quantity = parse_number(payload.get("quantity"), "Quantité", positive=True)
        location = clean_text(payload.get("location"), "Lieu de détention", required=True, max_length=80)
        category = clean_text(payload.get("category"), "Catégorie", max_length=40)
        name = clean_text(payload.get("name"), "Nom", max_length=120)
        manual_price: float | None = None

        if kind == "market":
            provider = payload.get("provider")
            if provider not in MARKET_PROVIDERS:
                raise ValidationError("Fournisseur de cours inconnu.")
            symbol: str | None = clean_symbol(payload.get("symbol"))
            quote = self.market.quote(provider, symbol)
            name = name or (quote.name or "") or symbol
            ticker = clean_text(payload.get("ticker"), "Ticker", max_length=20)
            if not ticker:
                ticker = yahoo_ticker(symbol, quote.instrument_type) if provider == "yahoo" else symbol.upper()
            if not category:
                category = category_for_type(quote.instrument_type) if provider == "yahoo" else "Crypto"
            quote_currency = quote.currency
        elif kind == "cash":
            currency = parse_currency(payload.get("currency"), "Devise", allow_minor=False)
            provider, symbol = "fx", currency
            quote = self.market.cash_quote(currency)
            name = name or f"Liquidités {currency}"
            ticker = currency
            category = category or "Liquidités"
            quote_currency = currency
        else:
            provider, symbol = "manual", None
            if not name:
                raise ValidationError("Nom : champ requis.")
            quote_currency = parse_currency(payload.get("currency") or "USD", "Devise")
            manual_price = parse_number(payload.get("manualPrice"), "Valeur unitaire")
            ticker = clean_text(payload.get("ticker"), "Unité", max_length=20)
            category = category or "Autre"
            quote = Quote(
                provider="manual",
                symbol="",
                price=manual_price,
                currency=quote_currency,
                price_usd=manual_price * self.market.fx_to_usd(quote_currency),
            )

        if kind == "cash":
            initial_currency, initial_unit_price = quote_currency, 1.0
        else:
            initial_currency = parse_currency(payload.get("initialCurrency"), "Devise d'achat", required=False) or quote.currency
            initial_unit_price = parse_number(payload.get("initialUnitPrice"), "Prix d'achat unitaire", required=False)
            if initial_unit_price is None:  # par défaut : le cours du jour
                initial_unit_price = quote.price_usd / self._fx_for(initial_currency, quote)
        initial_fx = self._fx_for(initial_currency, quote)

        now = self._now()
        values = {
            "kind": kind,
            "provider": provider,
            "symbol": symbol,
            "ticker": ticker,
            "name": name,
            "category": category,
            "quantity": quantity,
            "quote_currency": quote_currency,
            "manual_price": manual_price,
            "initial_unit_price": initial_unit_price,
            "initial_currency": initial_currency,
            "initial_fx_usd": initial_fx,
            "location": location,
            "created_at": now,
            "updated_at": now,
        }
        with self.db.transaction() as conn:
            asset_id = repo.insert_asset(conn, values)
            if kind == "manual":
                quote.symbol = str(asset_id)
                repo.update_asset(conn, asset_id, {"symbol": quote.symbol})
            record = quote.as_record()
            repo.upsert_quote(conn, record, now)
            repo.record_price(conn, record, now, PRICE_HISTORY_INTERVAL)
            asset = repo.get_asset(conn, asset_id)
            repo.insert_event(conn, asset_id, "create", public_asset(asset), None, now)
        return {"assetId": asset_id, "portfolio": self.portfolio()}

    def _fx_for(self, currency: str, quote: Quote) -> float:
        """Taux devise -> USD ; réutilise celui implicite dans le cours quand c'est la même devise."""
        if currency == quote.currency and quote.price > 0:
            return quote.price_usd / quote.price
        return self.market.fx_to_usd(currency)

    def update_asset(self, asset_id: int, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValidationError("Requête invalide.")
        with self.db.read() as conn:
            current = repo.get_asset(conn, asset_id)
        if not current or current["archived_at"]:
            raise NotFoundError("Actif introuvable.")
        kind = current["kind"]

        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = clean_text(payload["name"], "Nom", required=True, max_length=120)
        if "category" in payload:
            updates["category"] = clean_text(payload["category"], "Catégorie", required=True, max_length=40)
        if "location" in payload:
            updates["location"] = clean_text(payload["location"], "Lieu de détention", required=True, max_length=80)
        if "quantity" in payload:
            updates["quantity"] = parse_number(payload["quantity"], "Quantité", positive=True)
        if kind != "cash":
            if "initialUnitPrice" in payload:
                updates["initial_unit_price"] = parse_number(payload["initialUnitPrice"], "Prix d'achat unitaire")
            if "initialCurrency" in payload:
                updates["initial_currency"] = parse_currency(payload["initialCurrency"], "Devise d'achat")
        if kind == "manual":
            if "manualPrice" in payload:
                updates["manual_price"] = parse_number(payload["manualPrice"], "Valeur unitaire")
            if "currency" in payload:
                updates["quote_currency"] = parse_currency(payload["currency"], "Devise")
            if "ticker" in payload:
                updates["ticker"] = clean_text(payload["ticker"], "Unité", max_length=20)

        # Appels réseau éventuels (taux de change) avant d'ouvrir la transaction d'écriture.
        new_fx = None
        if updates.get("initial_currency", current["initial_currency"]) != current["initial_currency"]:
            new_fx = self.market.fx_to_usd(updates["initial_currency"])
        new_quote = None
        if kind == "manual" and ("manual_price" in updates or "quote_currency" in updates):
            price = updates.get("manual_price", current["manual_price"]) or 0.0
            currency = updates.get("quote_currency", current["quote_currency"])
            new_quote = Quote(
                provider="manual",
                symbol=current["symbol"],
                price=price,
                currency=currency,
                price_usd=price * self.market.fx_to_usd(currency),
            )

        now = self._now()
        with self.db.transaction() as conn:
            fresh = repo.get_asset(conn, asset_id)
            if not fresh or fresh["archived_at"]:
                raise NotFoundError("Actif introuvable.")
            changes = {column: (fresh[column], value) for column, value in updates.items() if fresh[column] != value}
            if not changes:
                changed = False
            else:
                changed = True
                values = {column: new for column, (_old, new) in changes.items()}
                if "initial_currency" in changes and new_fx is not None:
                    values["initial_fx_usd"] = new_fx
                values["updated_at"] = now
                repo.update_asset(conn, asset_id, values)
                if new_quote is not None and ("manual_price" in changes or "quote_currency" in changes):
                    record = new_quote.as_record()
                    repo.upsert_quote(conn, record, now)
                    repo.record_price(conn, record, now, PRICE_HISTORY_INTERVAL)
                asset = repo.get_asset(conn, asset_id)
                journal = {API_FIELDS[column]: {"from": old, "to": new} for column, (old, new) in changes.items()}
                repo.insert_event(conn, asset_id, "update", public_asset(asset), journal, now)
        return {"assetId": asset_id, "changed": changed, "portfolio": self.portfolio()}

    def archive_asset(self, asset_id: int) -> dict[str, Any]:
        now = self._now()
        with self.db.transaction() as conn:
            asset = repo.get_asset(conn, asset_id)
            if not asset or asset["archived_at"]:
                raise NotFoundError("Actif introuvable.")
            repo.update_asset(conn, asset_id, {"archived_at": now, "updated_at": now})
            asset = repo.get_asset(conn, asset_id)
            repo.insert_event(conn, asset_id, "archive", public_asset(asset), None, now)
        return {"assetId": asset_id, "portfolio": self.portfolio()}

    # ------------------------------------------------------------------ marché

    def refresh(self) -> dict[str, Any]:
        """Met à jour les cours de tous les actifs (en parallèle) et les historise."""
        with self._refresh_lock:
            moment = self.clock()
            now = to_iso(moment)
            with self.db.read() as conn:
                assets = repo.list_assets(conn)
                quotes = repo.get_quotes(conn)

            to_fetch: set[tuple[str, str]] = set()
            manual_assets = []
            for asset in assets:
                if asset["provider"] == "manual":
                    manual_assets.append(asset)
                    continue
                key = (asset["provider"], asset["symbol"])
                existing = quotes.get(key)
                if existing and not existing["error"]:
                    age = (moment - from_iso(existing["fetched_at"])).total_seconds()
                    if 0 <= age < REFRESH_MIN_INTERVAL:
                        continue
                to_fetch.add(key)

            results: dict[tuple[str, str], Quote | MarketError] = self.market.quotes(to_fetch) if to_fetch else {}
            for asset in manual_assets:  # les actifs manuels ne bougent qu'avec le taux de change
                price = asset["manual_price"] or 0.0
                try:
                    results[("manual", asset["symbol"])] = Quote(
                        provider="manual",
                        symbol=asset["symbol"],
                        price=price,
                        currency=asset["quote_currency"],
                        price_usd=price * self.market.fx_to_usd(asset["quote_currency"]),
                    )
                except MarketError as error:
                    results[("manual", asset["symbol"])] = error

            assets_by_key: dict[tuple[str, str], list[dict[str, Any]]] = {}
            for asset in assets:
                assets_by_key.setdefault((asset["provider"], asset["symbol"]), []).append(asset)

            errors: list[dict[str, Any]] = []
            successes = 0
            with self.db.transaction() as conn:
                for key, result in results.items():
                    if isinstance(result, MarketError):
                        repo.mark_quote_error(conn, key[0], key[1], str(result), now)
                        for asset in assets_by_key.get(key, []):
                            errors.append({"assetId": asset["id"], "name": asset["name"], "message": str(result)})
                        continue
                    successes += 1
                    record = result.as_record()
                    repo.upsert_quote(conn, record, now)
                    repo.record_price(conn, record, now, PRICE_HISTORY_INTERVAL)
                if successes or not results:
                    repo.set_setting(conn, "last_refresh_at", now)

            portfolio = self.portfolio()
            portfolio["refreshErrors"] = errors
            return portfolio

    def search(self, query: Any) -> dict[str, Any]:
        text = clean_text(query, "Recherche", required=True, max_length=64)
        return self.market.search(text)

    def quote(self, provider: Any, symbol: Any) -> dict[str, Any]:
        if provider not in ("yahoo", "coingecko", "fx"):
            raise ValidationError("Fournisseur de cours inconnu.")
        if provider == "fx":
            code = parse_currency(symbol, "Devise", allow_minor=False)
            return {"quote": quote_view(self.market.cash_quote(code))}
        return {"quote": quote_view(self.market.quote(provider, clean_symbol(symbol)))}

    def fx(self, currency: Any) -> dict[str, Any]:
        code = parse_currency(currency, "Devise")
        return {"currency": code, "usd": self.market.fx_to_usd(code)}
