import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from patrimony.db import Database
from patrimony.service import PortfolioService
from server import create_server

from tests.fakes import FakeMarket


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        service = PortfolioService(Database(Path(cls.tmp.name) / "server.db"), FakeMarket())
        cls.server = create_server("127.0.0.1", 0, service)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, raw_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        all_headers = {"Host": f"127.0.0.1:{self.port}"}
        if method in ("POST", "PUT", "DELETE"):
            all_headers["X-Patrimony"] = "1"
        data = raw_body
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            all_headers["Content-Type"] = "application/json"
        all_headers.update(headers or {})
        all_headers = {k: v for k, v in all_headers.items() if v is not None}
        conn.request(method, path, body=data, headers=all_headers)
        response = conn.getresponse()
        payload = response.read()
        conn.close()
        if "application/json" in (response.getheader("Content-Type") or ""):
            payload = json.loads(payload.decode("utf-8"))
        return response, payload

    def test_index_is_served_with_security_headers(self):
        response, body = self.request("GET", "/")
        self.assertEqual(response.status, 200)
        self.assertIn("text/html", response.getheader("Content-Type"))
        self.assertIn("default-src 'self'", response.getheader("Content-Security-Policy"))
        self.assertIn(b"Your Estates", body)

    def test_javascript_mime_type(self):
        response, _ = self.request("GET", "/js/main.js")
        self.assertEqual(response.status, 200)
        self.assertTrue(response.getheader("Content-Type").startswith("text/javascript"))

    def test_path_traversal_is_blocked(self):
        for path in ("/../server.py", "/%2e%2e/server.py", "/js/..%2f..%2fserver.py", "/data/patrimony.db"):
            with self.subTest(path=path):
                response, _ = self.request("GET", path)
                self.assertEqual(response.status, 404)

    def test_foreign_host_is_rejected(self):
        response, body = self.request("GET", "/api/portfolio", headers={"Host": "evil.example:8000"})
        self.assertEqual(response.status, 403)
        self.assertIn("error", body)

    def test_writes_require_custom_header(self):
        response, _ = self.request("POST", "/api/assets", body={"kind": "cash"}, headers={"X-Patrimony": None})
        self.assertEqual(response.status, 403)

    def test_full_asset_lifecycle(self):
        response, body = self.request("POST", "/api/assets", body={
            "kind": "market", "provider": "yahoo", "symbol": "AAPL", "quantity": 4,
            "initialUnitPrice": 150, "initialCurrency": "USD", "location": "Boursorama",
        })
        self.assertEqual(response.status, 201, body)
        asset_id = body["assetId"]
        self.assertTrue(any(a["id"] == asset_id for a in body["portfolio"]["assets"]))

        response, body = self.request("PUT", f"/api/assets/{asset_id}", body={"quantity": 5})
        self.assertEqual(response.status, 200)
        self.assertTrue(body["changed"])

        response, body = self.request("GET", f"/api/events?assetId={asset_id}")
        self.assertEqual([e["type"] for e in body["events"]], ["update", "create"])

        response, body = self.request("DELETE", f"/api/assets/{asset_id}")
        self.assertEqual(response.status, 200)
        self.assertFalse(any(a["id"] == asset_id for a in body["portfolio"]["assets"]))

        response, body = self.request("DELETE", f"/api/assets/{asset_id}")
        self.assertEqual(response.status, 404)

    def test_errors_are_json(self):
        cases = [
            ("POST", "/api/assets", {"kind": "market", "provider": "yahoo", "symbol": "AAPL", "quantity": -1, "location": "x"}, 400),
            ("POST", "/api/assets", {"kind": "market", "provider": "yahoo", "symbol": "UNKNOWN", "quantity": 1, "location": "x"}, 502),
            ("GET", "/api/nothing", None, 404),
            ("PUT", "/api/portfolio", {}, 405),
            ("GET", "/api/events?assetId=abc", None, 400),
        ]
        for method, path, body, status in cases:
            with self.subTest(method=method, path=path):
                response, payload = self.request(method, path, body=body)
                self.assertEqual(response.status, status)
                self.assertIsInstance(payload.get("error"), str)

    def test_invalid_json_body(self):
        response, _ = self.request("POST", "/api/assets", raw_body=b"{oops", headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        response, _ = self.request("POST", "/api/assets", raw_body=b"kind=cash", headers={"Content-Type": "text/plain"})
        self.assertEqual(response.status, 415)

    def test_search_quote_and_fx(self):
        _, body = self.request("GET", "/api/search?q=apple")
        self.assertEqual(body["results"][0]["symbol"], "AAPL")
        _, body = self.request("GET", "/api/quote?provider=yahoo&symbol=MC.PA")
        self.assertEqual(body["quote"]["currency"], "EUR")
        self.assertAlmostEqual(body["quote"]["priceUsd"], 660.0)
        _, body = self.request("GET", "/api/fx?currency=GBp")
        self.assertAlmostEqual(body["usd"], 0.0125)


if __name__ == "__main__":
    unittest.main()
