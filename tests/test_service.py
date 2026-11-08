import tempfile
import unittest
from pathlib import Path

from patrimony import db as repo
from patrimony.db import Database
from patrimony.market import MarketError
from patrimony.service import NotFoundError, PortfolioService, ValidationError

from tests.fakes import Clock, FakeMarket


class ServiceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.db_path = Path(self.tmp.name) / "patrimony.db"
        self.market = FakeMarket()
        self.clock = Clock()
        self.service = PortfolioService(Database(self.db_path), self.market, clock=self.clock)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def create(self, **payload):
        base = {"kind": "market", "provider": "yahoo", "location": "Boursorama", "quantity": 1}
        base.update(payload)
        return self.service.create_asset(base)

    def asset(self, portfolio, asset_id):
        return next(a for a in portfolio["assets"] if a["id"] == asset_id)


class CreateAssetTests(ServiceTestCase):
    def test_market_asset_is_valued_and_journaled(self):
        result = self.create(symbol="AAPL", quantity=10, initialUnitPrice=150, initialCurrency="USD")
        asset = self.asset(result["portfolio"], result["assetId"])
        self.assertEqual(asset["name"], "Apple Inc.")
        self.assertEqual(asset["ticker"], "AAPL")
        self.assertEqual(asset["category"], "Action")
        self.assertAlmostEqual(asset["valueUsd"], 2000.0)
        self.assertAlmostEqual(asset["initialValueUsd"], 1500.0)
        self.assertAlmostEqual(asset["pnlUsd"], 500.0)
        self.assertAlmostEqual(asset["share"], 1.0)

        events = self.service.events()["events"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "create")
        self.assertEqual(events[0]["asset"]["quantity"], 10)
        self.assertEqual(events[0]["asset"]["location"], "Boursorama")

    def test_initial_price_defaults_to_current_price_in_quote_currency(self):
        result = self.create(symbol="MC.PA", quantity=2)
        asset = self.asset(result["portfolio"], result["assetId"])
        self.assertEqual(asset["initialCurrency"], "EUR")
        self.assertAlmostEqual(asset["initialUnitPrice"], 600.0)
        self.assertAlmostEqual(asset["initialFxUsd"], 1.10)
        self.assertAlmostEqual(asset["initialValueUsd"], 2 * 600 * 1.10)

    def test_initial_value_keeps_exchange_rate_of_entry(self):
        result = self.create(symbol="MC.PA", quantity=2, initialUnitPrice="500,00", initialCurrency="EUR")
        self.market.rates["EUR"] = 1.20
        self.clock.advance(60)
        asset = self.asset(self.service.refresh(), result["assetId"])
        self.assertAlmostEqual(asset["initialValueUsd"], 2 * 500 * 1.10)
        self.assertAlmostEqual(asset["valueUsd"], 2 * 600 * 1.20)

    def test_pence_quoted_stock_is_converted(self):
        result = self.create(symbol="VOD.L", quantity=100)
        asset = self.asset(result["portfolio"], result["assetId"])
        self.assertEqual(asset["priceCurrency"], "GBp")
        self.assertAlmostEqual(asset["priceUsd"], 120 * 0.01 * 1.25)
        self.assertAlmostEqual(asset["valueUsd"], 150.0)

    def test_crypto_from_coingecko(self):
        result = self.create(provider="coingecko", symbol="bitcoin", ticker="BTC", name="Bitcoin", quantity=0.5,
                             initialUnitPrice=40000, initialCurrency="USD", location="Ledger")
        asset = self.asset(result["portfolio"], result["assetId"])
        self.assertEqual(asset["category"], "Crypto")
        self.assertEqual(asset["ticker"], "BTC")
        self.assertAlmostEqual(asset["valueUsd"], 25000.0)

    def test_cash_asset_follows_exchange_rate(self):
        result = self.service.create_asset({"kind": "cash", "currency": "eur", "quantity": 1000, "location": "Banque"})
        asset = self.asset(result["portfolio"], result["assetId"])
        self.assertEqual(asset["name"], "Liquidités EUR")
        self.assertEqual(asset["ticker"], "EUR")
        self.assertEqual(asset["category"], "Liquidités")
        self.assertAlmostEqual(asset["valueUsd"], 1100.0)
        self.assertAlmostEqual(asset["initialValueUsd"], 1100.0)

        self.market.rates["EUR"] = 1.05
        self.clock.advance(60)
        asset = self.asset(self.service.refresh(), result["assetId"])
        self.assertAlmostEqual(asset["valueUsd"], 1050.0)
        self.assertAlmostEqual(asset["initialValueUsd"], 1100.0)

    def test_manual_asset(self):
        result = self.service.create_asset({
            "kind": "manual", "name": "Appartement Lyon", "category": "Immobilier", "quantity": 1,
            "manualPrice": 300000, "currency": "EUR", "location": "Lyon",
        })
        asset = self.asset(result["portfolio"], result["assetId"])
        self.assertEqual(asset["symbol"], str(result["assetId"]))
        self.assertAlmostEqual(asset["valueUsd"], 330000.0)
        self.assertAlmostEqual(asset["initialValueUsd"], 330000.0)

        updated = self.service.update_asset(result["assetId"], {"manualPrice": 320000})
        asset = self.asset(updated["portfolio"], result["assetId"])
        self.assertAlmostEqual(asset["valueUsd"], 352000.0)
        self.assertAlmostEqual(asset["initialValueUsd"], 330000.0)
        change = self.service.events(result["assetId"])["events"][0]["changes"]["manualPrice"]
        self.assertEqual(change, {"from": 300000.0, "to": 320000.0})

    def test_unknown_symbol_creates_nothing(self):
        with self.assertRaises(MarketError):
            self.create(symbol="ZZZZ")
        self.assertEqual(self.service.portfolio()["assets"], [])
        self.assertEqual(self.service.events()["events"], [])

    def test_validation_errors(self):
        invalid_payloads = [
            {"symbol": "AAPL", "quantity": 0},
            {"symbol": "AAPL", "quantity": -3},
            {"symbol": "AAPL", "quantity": "abc"},
            {"symbol": "AAPL", "quantity": "nan"},
            {"symbol": "AAPL", "location": "  "},
            {"symbol": "AAPL", "kind": "stock"},
            {"symbol": "AAPL", "initialCurrency": "EURO"},
            {"symbol": "AAPL", "initialUnitPrice": -1},
            {"symbol": "AA PL"},
            {"symbol": "AAPL", "provider": "bloomberg"},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                self.create(**payload)
        with self.assertRaises(ValidationError):
            self.service.create_asset({"kind": "manual", "quantity": 1, "manualPrice": 10, "location": "x"})
        with self.assertRaises(ValidationError):
            self.service.create_asset({"kind": "cash", "currency": "EURO", "quantity": 1, "location": "x"})


class UpdateAndArchiveTests(ServiceTestCase):
    def test_update_records_each_change(self):
        asset_id = self.create(symbol="AAPL", quantity=10, initialUnitPrice=150)["assetId"]
        self.clock.advance(30)
        result = self.service.update_asset(asset_id, {"quantity": "12,5", "location": "Degiro", "name": "Apple Inc."})
        self.assertTrue(result["changed"])
        asset = self.asset(result["portfolio"], asset_id)
        self.assertAlmostEqual(asset["quantity"], 12.5)
        self.assertEqual(asset["location"], "Degiro")

        events = self.service.events(asset_id)["events"]
        self.assertEqual([e["type"] for e in events], ["update", "create"])
        self.assertEqual(events[0]["changes"], {
            "quantity": {"from": 10.0, "to": 12.5},
            "location": {"from": "Boursorama", "to": "Degiro"},
        })

    def test_update_without_change_writes_nothing(self):
        asset_id = self.create(symbol="AAPL", quantity=10)["assetId"]
        result = self.service.update_asset(asset_id, {"quantity": 10, "location": "Boursorama"})
        self.assertFalse(result["changed"])
        self.assertEqual(len(self.service.events(asset_id)["events"]), 1)

    def test_changing_purchase_currency_fetches_new_rate(self):
        asset_id = self.create(symbol="AAPL", quantity=1, initialUnitPrice=150, initialCurrency="USD")["assetId"]
        result = self.service.update_asset(asset_id, {"initialUnitPrice": 100, "initialCurrency": "CHF"})
        asset = self.asset(result["portfolio"], asset_id)
        self.assertAlmostEqual(asset["initialFxUsd"], 1.20)
        self.assertAlmostEqual(asset["initialValueUsd"], 120.0)

    def test_archive_hides_asset_but_keeps_history(self):
        asset_id = self.create(symbol="AAPL", quantity=10)["assetId"]
        result = self.service.archive_asset(asset_id)
        self.assertEqual(result["portfolio"]["assets"], [])

        history = self.service.events()
        self.assertEqual([e["type"] for e in history["events"]], ["archive", "create"])
        self.assertTrue(history["assets"][0]["archived"])
        with self.assertRaises(NotFoundError):
            self.service.archive_asset(asset_id)
        with self.assertRaises(NotFoundError):
            self.service.update_asset(asset_id, {"quantity": 1})


class PortfolioTests(ServiceTestCase):
    def test_shares_totals_and_order(self):
        self.create(symbol="AAPL", quantity=10, initialUnitPrice=100)  # 2 000 $, achat 1 000 $
        self.create(provider="coingecko", symbol="bitcoin", ticker="BTC", name="Bitcoin", quantity=0.1,
                    initialUnitPrice=30000)  # 5 000 $, achat 3 000 $
        self.service.create_asset({"kind": "cash", "currency": "USD", "quantity": 3000, "location": "Banque"})

        portfolio = self.service.portfolio()
        self.assertEqual([a["name"] for a in portfolio["assets"]], ["Bitcoin", "Liquidités USD", "Apple Inc."])
        self.assertAlmostEqual(sum(a["share"] for a in portfolio["assets"]), 1.0)
        totals = portfolio["totals"]
        self.assertAlmostEqual(totals["valueUsd"], 10000.0)
        self.assertAlmostEqual(totals["initialValueUsd"], 7000.0)
        self.assertAlmostEqual(totals["pnlUsd"], 3000.0)
        self.assertAlmostEqual(totals["pnlPct"], 3000 / 7000)
        expected_day = 2000 * 1.5 / 101.5 + 5000 * 3.0 / 103.0
        self.assertAlmostEqual(totals["dayChangeUsd"], expected_day)
        self.assertEqual(totals["count"], 3)
        self.assertEqual(totals["locations"], 2)

    def test_data_survives_restart(self):
        asset_id = self.create(symbol="AAPL", quantity=3)["assetId"]
        restarted = PortfolioService(Database(self.db_path), FakeMarket(), clock=self.clock)
        asset = self.asset(restarted.portfolio(), asset_id)
        self.assertAlmostEqual(asset["valueUsd"], 600.0)
        self.assertEqual(len(restarted.events()["events"]), 1)


class RefreshTests(ServiceTestCase):
    def test_failed_refresh_keeps_last_price_and_reports_error(self):
        asset_id = self.create(symbol="AAPL", quantity=10)["assetId"]
        self.market.failing.add(("yahoo", "AAPL"))
        self.clock.advance(60)
        portfolio = self.service.refresh()
        self.assertEqual(len(portfolio["refreshErrors"]), 1)
        asset = self.asset(portfolio, asset_id)
        self.assertAlmostEqual(asset["valueUsd"], 2000.0)
        self.assertIn("indisponible", asset["quoteError"])

        self.market.failing.clear()
        self.market.instruments[("yahoo", "AAPL")]["price"] = 210.0
        self.clock.advance(60)
        asset = self.asset(self.service.refresh(), asset_id)
        self.assertIsNone(asset["quoteError"])
        self.assertAlmostEqual(asset["valueUsd"], 2100.0)

    def test_recent_quotes_are_not_fetched_again(self):
        self.create(symbol="AAPL", quantity=1)
        calls = len(self.market.quote_calls)
        self.service.refresh()
        self.assertEqual(len(self.market.quote_calls), calls)
        self.clock.advance(10)
        self.service.refresh()
        self.assertEqual(len(self.market.quote_calls), calls + 1)

    def test_price_history_is_throttled(self):
        self.create(symbol="AAPL", quantity=1)

        def history_count():
            with self.service.db.read() as conn:
                return repo.count_price_history(conn, "yahoo", "AAPL")

        self.assertEqual(history_count(), 1)
        self.market.instruments[("yahoo", "AAPL")]["price"] = 201.0
        self.clock.advance(60)
        self.service.refresh()
        self.assertEqual(history_count(), 1)  # moins de 5 minutes depuis le dernier point
        self.clock.advance(300)
        self.service.refresh()
        self.assertEqual(history_count(), 2)
        self.clock.advance(600)
        self.service.refresh()
        self.assertEqual(history_count(), 2)  # cours inchangé : pas de nouveau point

    def test_last_refresh_timestamp(self):
        self.create(symbol="AAPL", quantity=1)
        self.clock.advance(60)
        portfolio = self.service.refresh()
        self.assertEqual(portfolio["lastRefreshAt"], "2026-11-08T12:01:00.000Z")


if __name__ == "__main__":
    unittest.main()
