#!/usr/bin/env python3
"""Your Estates : serveur web local, sans aucune dépendance externe.

Lancement :  python server.py            puis ouvrir http://127.0.0.1:8000
Options   :  --port 8000   --host 127.0.0.1   --db data/patrimony.db   --no-browser
"""
from __future__ import annotations

import argparse
import errno
import json
import os
import re
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlsplit

from patrimony import __version__
from patrimony.db import Database
from patrimony.market import MarketData, MarketError
from patrimony.service import NotFoundError, PortfolioService, ValidationError

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = (BASE_DIR / "static").resolve()
DEFAULT_DB = BASE_DIR / "data" / "patrimony.db"
DEFAULT_PORT = 8000
MAX_BODY_BYTES = 64 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
PORT_IN_USE = {errno.EADDRINUSE, errno.EACCES, 10048, 10013}  # 10048 / 10013 : codes Windows (WSA)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Request:
    """Accès simplifié aux paramètres et au corps JSON d'une requête."""

    def __init__(self, handler: BaseHTTPRequestHandler, query: str) -> None:
        self._handler = handler
        self._params = parse_qs(query, keep_blank_values=True)
        self._body: dict[str, Any] | None = None

    def arg(self, name: str, default: str | None = None) -> str | None:
        values = self._params.get(name)
        return values[0] if values else default

    def int_arg(self, name: str) -> int | None:
        value = self.arg(name)
        if value in (None, ""):
            return None
        try:
            return int(value)
        except ValueError:
            raise ApiError(400, f"Paramètre « {name} » invalide.") from None

    def json(self) -> dict[str, Any]:
        if self._body is not None:
            return self._body
        try:
            length = int(self._handler.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "En-tête Content-Length invalide.") from None
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "Requête trop volumineuse.")
        raw = self._handler.rfile.read(length) if length > 0 else b""
        if not raw:
            self._body = {}
            return self._body
        content_type = (self._handler.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(415, "Le corps de la requête doit être du JSON.")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "JSON invalide.") from None
        if not isinstance(body, dict):
            raise ApiError(400, "Un objet JSON est attendu.")
        self._body = body
        return body


Route = tuple[str, "re.Pattern[str]", Callable[..., Any], int]


def build_routes(service: PortfolioService) -> list[Route]:
    routes: list[tuple[str, str, Callable[..., Any], int]] = [
        ("GET", r"/api/health", lambda req: {"ok": True, "version": __version__}, 200),
        ("GET", r"/api/portfolio", lambda req: service.portfolio(), 200),
        ("POST", r"/api/refresh", lambda req: service.refresh(), 200),
        ("POST", r"/api/assets", lambda req: service.create_asset(req.json()), 201),
        ("PUT", r"/api/assets/(\d+)", lambda req, asset_id: service.update_asset(int(asset_id), req.json()), 200),
        ("DELETE", r"/api/assets/(\d+)", lambda req, asset_id: service.archive_asset(int(asset_id)), 200),
        ("GET", r"/api/events", lambda req: service.events(req.int_arg("assetId"), req.int_arg("limit") or 300), 200),
        ("GET", r"/api/search", lambda req: service.search(req.arg("q", "")), 200),
        ("GET", r"/api/quote", lambda req: service.quote(req.arg("provider"), req.arg("symbol")), 200),
        ("GET", r"/api/fx", lambda req: service.fx(req.arg("currency")), 200),
    ]
    return [(method, re.compile(pattern), handler, status) for method, pattern, handler, status in routes]


class Handler(BaseHTTPRequestHandler):
    server: "PatrimonyServer"
    server_version = f"Patrimony/{__version__}"
    sys_version = ""

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    # ------------------------------------------------------------------ aiguillage

    def _dispatch(self, method: str) -> None:
        url = urlsplit(self.path)
        try:
            if not self._host_allowed():
                raise ApiError(403, "Hôte non autorisé.")
            if url.path.startswith("/api/"):
                self._api(method, url.path, url.query)
            elif method == "GET":
                self._static(url.path)
            else:
                raise ApiError(405, "Méthode non autorisée.")
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})

    def _host_allowed(self) -> bool:
        """Protection contre le « DNS rebinding » quand le serveur n'écoute qu'en local."""
        if not self.server.loopback_only:
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            hostname = host[1:host.find("]")] if "]" in host else host
        else:
            hostname = host.rsplit(":", 1)[0]
        return hostname in LOOPBACK_HOSTS

    def _api(self, method: str, path: str, query: str) -> None:
        # Un en-tête personnalisé force une requête « preflight » CORS : une page web tierce
        # ne peut donc pas modifier vos données à votre insu.
        if method in ("POST", "PUT", "DELETE") and self.headers.get("X-Patrimony") != "1":
            raise ApiError(403, "Requête refusée.")
        handler, args, status = self._route(method, path)
        try:
            payload = handler(Request(self, query), *args)
        except ApiError:
            raise
        except ValidationError as error:
            raise ApiError(400, str(error)) from None
        except NotFoundError as error:
            raise ApiError(404, str(error)) from None
        except MarketError as error:
            raise ApiError(502, str(error)) from None
        except Exception:
            traceback.print_exc()
            raise ApiError(500, "Erreur interne du serveur.") from None
        self._send_json(status, payload)

    def _route(self, method: str, path: str) -> tuple[Callable[..., Any], tuple[str, ...], int]:
        path_matched = False
        for route_method, pattern, handler, status in self.server.routes:
            match = pattern.fullmatch(path)
            if not match:
                continue
            if route_method == method:
                return handler, match.groups(), status
            path_matched = True
        if path_matched:
            raise ApiError(405, "Méthode non autorisée.")
        raise ApiError(404, "Ressource introuvable.")

    def _static(self, raw_path: str) -> None:
        path = unquote(raw_path)
        if path in ("", "/"):
            path = "/index.html"
        try:
            target = (STATIC_DIR / path.lstrip("/")).resolve()
            target.relative_to(STATIC_DIR)
        except (ValueError, OSError):
            raise ApiError(404, "Fichier introuvable.") from None
        content_type = CONTENT_TYPES.get(target.suffix.lower())
        if content_type is None or not target.is_file():
            raise ApiError(404, "Fichier introuvable.")
        headers = {"Content-Type": content_type, "Cache-Control": "no-cache"}
        if target.suffix.lower() == ".html":
            headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
        self._send(200, target.read_bytes(), headers)

    # ------------------------------------------------------------------ réponses

    def _send_json(self, status: int, payload: Any) -> None:
        try:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        except ValueError:
            traceback.print_exc()
            status, body = 500, json.dumps({"error": "Erreur interne du serveur."})
        self._send(status, body.encode("utf-8"), {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        })

    def _send(self, status: int, body: bytes, headers: dict[str, str]) -> None:
        self.send_response(status)
        for name, value in {**SECURITY_HEADERS, **headers}.items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        try:
            status = int(code)
        except (TypeError, ValueError):
            status = 0
        if self.path.startswith("/api/") or status >= 400:
            sys.stderr.write(f"[{self.log_date_time_string()}] {self.command} {self.path} -> {status}\n")


class PatrimonyServer(ThreadingHTTPServer):
    daemon_threads = True
    # Sous Windows, SO_REUSEADDR permettrait de partager silencieusement un port déjà occupé.
    allow_reuse_address = os.name != "nt"

    def __init__(self, address: tuple[str, int], service: PortfolioService) -> None:
        super().__init__(address, Handler)
        self.service = service
        self.routes = build_routes(service)
        self.loopback_only = address[0] in LOOPBACK_HOSTS


def create_server(host: str, port: int, service: PortfolioService, *, port_fallback: bool = False) -> PatrimonyServer:
    attempts = 10 if port_fallback and port else 1
    for offset in range(attempts):
        try:
            return PatrimonyServer((host, port + offset if port else 0), service)
        except OSError as error:
            if error.errno not in PORT_IN_USE or offset + 1 == attempts:
                raise
    raise OSError("Aucun port disponible.")


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            # UTF-8 partout (console, Git Bash, fichier journal) et jamais d'erreur d'encodage.
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description="Your Estates : tableau de bord de vos actifs financiers.")
    parser.add_argument("--host", default=os.environ.get("PATRIMONY_HOST", "127.0.0.1"),
                        help="adresse d'écoute (défaut : 127.0.0.1, accès local uniquement)")
    parser.add_argument("--port", type=int, default=None, help=f"port HTTP (défaut : {DEFAULT_PORT} ou le suivant libre)")
    parser.add_argument("--db", default=os.environ.get("PATRIMONY_DB", str(DEFAULT_DB)),
                        help="fichier de base de données SQLite (défaut : data/patrimony.db)")
    parser.add_argument("--no-browser", action="store_true", help="ne pas ouvrir le navigateur au démarrage")
    args = parser.parse_args(argv)

    env_port = os.environ.get("PATRIMONY_PORT")
    port = args.port if args.port is not None else int(env_port or DEFAULT_PORT)
    port_fallback = args.port is None and not env_port

    database = Database(args.db)
    market = MarketData(coingecko_api_key=os.environ.get("COINGECKO_API_KEY") or None)
    service = PortfolioService(database, market)
    try:
        server = create_server(args.host, port, service, port_fallback=port_fallback)
    except OSError as error:
        print(f"Impossible d'écouter sur {args.host}:{port} ({error}). Essayez par exemple --port 8080.", file=sys.stderr)
        return 1

    bound_host, bound_port = server.server_address[:2]
    shown_host = "127.0.0.1" if bound_host in ("0.0.0.0", "") else bound_host
    url = f"http://{shown_host}:{bound_port}/"
    print(f"Your Estates {__version__} est lancé : {url}")
    print(f"Données enregistrées dans : {Path(args.db).resolve()}")
    if not server.loopback_only:
        print("Attention : le serveur est accessible depuis le réseau, sans authentification.")
    print("Fermez cette fenêtre ou appuyez sur Ctrl+C pour arrêter.")
    sys.stdout.flush()

    if not args.no_browser:
        threading.Timer(0.7, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nArrêt de Your Estates.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
