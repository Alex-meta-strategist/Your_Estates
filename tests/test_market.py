import unittest

from patrimony.market import MarketData, MarketError


def chart(price, currency, change=None, **meta):
    meta.update({"regularMarketPrice": price, "currency": currency})
    if change is not None:
        meta["regularMarketChangePercent"] = change
    return {"chart": {"result": [{"meta": meta}], "error": None}}


class FakeHttp:
    """Répond aux URL contenant un motif donné ; tout le reste est « introuvable »."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        for pattern, response in self.routes.items():
            if pattern in url:
                if isinstance(response, Exception):
                    raise response
                return response
        raise MarketError("ressource introuvable", not_found=True)


class YahooTests(unittest.TestCase):
    def test_usd_quote(self):
        http = FakeHttp({"/chart/AAPL?": chart(342.37, "USD", -0.52, longName="Apple Inc.", instrumentType="EQUITY",
                                               regularMarketTime=1794000000)})
        quote = MarketData(fetch_json=http).yahoo_quote("AAPL")
        self.assertEqual(quote.price, 342.37)
        self.assertEqual(quote.price_usd, 342.37)
        self.assertEqual(quote.change_pct, -0.52)
        self.assertEqual(quote.name, "Apple Inc.")
        self.assertEqual(quote.market_time, "2026-11-06T21:20:00Z")

    def test_pence_quote_converted_to_usd(self):
        http = FakeHttp({
            "/chart/VOD.L?": chart(116.5, "GBp", instrumentType="EQUITY"),
            "/chart/GBPUSD%3DX?": chart(1.27, "USD"),
        })
        quote = MarketData(fetch_json=http).yahoo_quote("VOD.L")
        self.assertAlmostEqual(quote.price_usd, 116.5 * 0.01 * 1.27)

    def test_change_computed_from_previous_close(self):
        http = FakeHttp({"/chart/%5EGSPC?": chart(110.0, "USD", chartPreviousClose=100.0)})
        quote = MarketData(fetch_json=http).yahoo_quote("^GSPC")
        self.assertAlmostEqual(quote.change_pct, 10.0)

    def test_unknown_symbol(self):
        with self.assertRaises(MarketError) as raised:
            MarketData(fetch_json=FakeHttp({})).yahoo_quote("NOPE")
        self.assertTrue(raised.exception.not_found)
        self.assertIn("NOPE", str(raised.exception))

    def test_second_host_used_when_first_fails(self):
        http = FakeHttp({
            "query1.finance.yahoo.com/v8/finance/chart/AAPL": MarketError("erreur HTTP 503"),
            "query2.finance.yahoo.com/v8/finance/chart/AAPL": chart(10.0, "USD"),
        })
        self.assertEqual(MarketData(fetch_json=http).yahoo_quote("AAPL").price, 10.0)


class FxTests(unittest.TestCase):
    def test_fallback_to_frankfurter(self):
        http = FakeHttp({
            "/chart/EURUSD%3DX?": MarketError("erreur HTTP 503"),
            "frankfurter": {"base": "USD", "rates": {"EUR": 0.8}},
        })
        self.assertAlmostEqual(MarketData(fetch_json=http).fx_to_usd("EUR"), 1.25)

    def test_rates_are_cached(self):
        http = FakeHttp({"/chart/EURUSD%3DX?": chart(1.1, "USD")})
        market = MarketData(fetch_json=http)
        self.assertEqual(market.fx_to_usd("EUR"), 1.1)
        self.assertEqual(market.fx_to_usd("eur"), 1.1)
        self.assertEqual(len(http.calls), 1)

    def test_stale_rate_used_when_providers_fail(self):
        http = FakeHttp({"/chart/EURUSD%3DX?": chart(1.1, "USD")})
        market = MarketData(fetch_json=http, fx_ttl=0)
        market.fx_to_usd("EUR")
        http.routes = {}
        self.assertEqual(market.fx_to_usd("EUR"), 1.1)

    def test_usd_needs_no_request(self):
        http = FakeHttp({})
        self.assertEqual(MarketData(fetch_json=http).fx_to_usd("USD"), 1.0)
        self.assertEqual(http.calls, [])

    def test_unknown_currency(self):
        with self.assertRaises(MarketError):
            MarketData(fetch_json=FakeHttp({"frankfurter": {"rates": {}}})).fx_to_usd("XYZ")


class CoinGeckoAndBatchTests(unittest.TestCase):
    def test_batch_with_missing_coin(self):
        http = FakeHttp({"/simple/price?": {"bitcoin": {"usd": 75939, "usd_24h_change": 0.06, "last_updated_at": 1794149309}}})
        results = MarketData(fetch_json=http).coingecko_quotes(["bitcoin", "doesnotexist"])
        self.assertEqual(results["bitcoin"].price_usd, 75939)
        self.assertIsInstance(results["doesnotexist"], MarketError)
        self.assertEqual(len(http.calls), 1)

    def test_one_failure_does_not_block_the_others(self):
        http = FakeHttp({
            "/chart/AAPL?": chart(100.0, "USD"),
            "/simple/price?": {"ethereum": {"usd": 2238.28}},
        })
        results = MarketData(fetch_json=http).quotes([("yahoo", "AAPL"), ("yahoo", "BROKEN"), ("coingecko", "ethereum")])
        self.assertEqual(results[("yahoo", "AAPL")].price, 100.0)
        self.assertIsInstance(results[("yahoo", "BROKEN")], MarketError)
        self.assertEqual(results[("coingecko", "ethereum")].price, 2238.28)

    def test_cash_quote(self):
        http = FakeHttp({"/chart/EURUSD%3DX?": chart(1.1143, "USD", -0.67)})
        quote = MarketData(fetch_json=http).cash_quote("eur")
        self.assertEqual((quote.symbol, quote.price, quote.price_usd, quote.change_pct), ("EUR", 1.0, 1.1143, -0.67))


class SearchTests(unittest.TestCase):
    YAHOO = {"quotes": [
        {"symbol": "BTC-USD", "quoteType": "CRYPTOCURRENCY", "shortname": "Bitcoin USD", "exchDisp": "CCC"},
        {"symbol": "IBIT", "quoteType": "ETF", "longname": "iShares Bitcoin Trust ETF", "exchDisp": "NASDAQ"},
        {"symbol": "BTC250101C", "quoteType": "OPTION", "shortname": "Option"},
    ]}

    def test_coingecko_preferred_for_crypto(self):
        http = FakeHttp({
            "/v1/finance/search?": self.YAHOO,
            "coingecko.com/api/v3/search?": {"coins": [{"id": "bitcoin", "name": "Bitcoin", "symbol": "btc", "market_cap_rank": 1}]},
        })
        results = MarketData(fetch_json=http).search("bitcoin")["results"]
        self.assertEqual([(r["provider"], r["symbol"]) for r in results], [("coingecko", "bitcoin"), ("yahoo", "IBIT")])
        self.assertEqual(results[0]["ticker"], "BTC")
        self.assertEqual(results[1]["category"], "ETF")

    def test_yahoo_first_for_stock_queries(self):
        http = FakeHttp({
            "/v1/finance/search?": {"quotes": [{"symbol": "AAPL", "quoteType": "EQUITY", "longname": "Apple Inc."}]},
            "coingecko.com/api/v3/search?": {"coins": [{"id": "apple-token", "name": "Apple Token", "symbol": "apple"}]},
        })
        results = MarketData(fetch_json=http).search("aapl")["results"]
        self.assertEqual(results[0]["symbol"], "AAPL")

    def test_yahoo_crypto_kept_when_coingecko_down(self):
        http = FakeHttp({
            "/v1/finance/search?": self.YAHOO,
            "coingecko.com/api/v3/search?": MarketError("erreur HTTP 429"),
        })
        data = MarketData(fetch_json=http).search("bitcoin")
        self.assertEqual([r["symbol"] for r in data["results"]], ["BTC-USD", "IBIT"])
        self.assertEqual(data["results"][0]["ticker"], "BTC")
        self.assertEqual(len(data["errors"]), 1)


if __name__ == "__main__":
    unittest.main()
