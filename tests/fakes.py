"""Doublures de test : marché déterministe et horloge contrôlable."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from patrimony.market import MarketError, Quote


class Clock:
    def __init__(self, start: datetime | None = None) -> None:
        self.now = start or datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


class FakeMarket:
    """Même interface que ``MarketData``, sans réseau."""

    def __init__(self) -> None:
        self.instruments = {
            ("yahoo", "AAPL"): {"price": 200.0, "currency": "USD", "change": 1.5, "name": "Apple Inc.", "type": "EQUITY"},
            ("yahoo", "MC.PA"): {"price": 600.0, "currency": "EUR", "change": -2.0, "name": "LVMH", "type": "EQUITY"},
            ("yahoo", "VOD.L"): {"price": 120.0, "currency": "GBp", "change": 0.5, "name": "Vodafone", "type": "EQUITY"},
            ("yahoo", "CW8.PA"): {"price": 500.0, "currency": "EUR", "change": 0.1, "name": "Amundi MSCI World", "type": "ETF"},
            ("coingecko", "bitcoin"): {"price": 50000.0, "currency": "USD", "change": 3.0, "name": None, "type": "CRYPTOCURRENCY"},
            ("coingecko", "ethereum"): {"price": 2500.0, "currency": "USD", "change": -1.0, "name": None, "type": "CRYPTOCURRENCY"},
        }
        self.rates = {"EUR": 1.10, "GBP": 1.25, "CHF": 1.20}
        self.failing: set[tuple[str, str]] = set()
        self.quote_calls: list[tuple[str, str]] = []

    def fx_to_usd(self, currency: str) -> float:
        if currency in ("GBp", "GBX"):
            return self.fx_to_usd("GBP") * 0.01
        code = currency.upper()
        if code == "USD":
            return 1.0
        if code not in self.rates:
            raise MarketError(f"Taux de change {code} -> USD indisponible.")
        return self.rates[code]

    def quote(self, provider: str, symbol: str) -> Quote:
        self.quote_calls.append((provider, symbol))
        if provider == "fx":
            return self.cash_quote(symbol)
        key = (provider, symbol)
        if key in self.failing:
            raise MarketError(f"Service indisponible pour {symbol}.")
        info = self.instruments.get(key)
        if info is None:
            raise MarketError(f"Symbole « {symbol} » introuvable.", not_found=True)
        return Quote(
            provider=provider,
            symbol=symbol,
            price=info["price"],
            currency=info["currency"],
            price_usd=info["price"] * self.fx_to_usd(info["currency"]),
            change_pct=info["change"],
            name=info["name"],
            instrument_type=info["type"],
        )

    def cash_quote(self, currency: str) -> Quote:
        code = currency.upper()
        if ("fx", code) in self.failing:
            raise MarketError(f"Taux de change {code} -> USD indisponible.")
        return Quote(
            provider="fx",
            symbol=code,
            price=1.0,
            currency=code,
            price_usd=self.fx_to_usd(code),
            change_pct=None if code == "USD" else 0.2,
            name=f"Liquidités {code}",
            instrument_type="CASH",
        )

    def quotes(self, keys):
        results = {}
        for key in keys:
            try:
                results[key] = self.quote(*key)
            except MarketError as error:
                results[key] = error
        return results

    def search(self, text: str):
        return {
            "results": [{
                "provider": "yahoo", "symbol": "AAPL", "ticker": "AAPL", "name": "Apple Inc.",
                "exchange": "NASDAQ", "type": "Action", "category": "Action",
            }],
            "errors": [],
        }
