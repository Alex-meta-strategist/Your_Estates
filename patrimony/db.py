"""Persistance SQLite.

Le modèle est historisé :

* ``assets`` contient l'état courant de chaque actif déclaré ;
* ``asset_events`` est un journal en ajout seul : chaque création, modification
  ou suppression y est enregistrée avec un instantané complet de l'actif ;
* les suppressions sont logiques (``archived_at``), rien n'est jamais effacé ;
* ``quotes`` garde le dernier cours connu de chaque instrument, pour afficher
  les valeurs dès le redémarrage, et ``price_history`` conserve la série des cours.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    kind               TEXT    NOT NULL CHECK (kind IN ('market', 'cash', 'manual')),
    provider           TEXT    NOT NULL CHECK (provider IN ('yahoo', 'coingecko', 'fx', 'manual')),
    symbol             TEXT,
    ticker             TEXT    NOT NULL DEFAULT '',
    name               TEXT    NOT NULL,
    category           TEXT    NOT NULL,
    quantity           REAL    NOT NULL,
    quote_currency     TEXT    NOT NULL,
    manual_price       REAL,
    initial_unit_price REAL    NOT NULL,
    initial_currency   TEXT    NOT NULL,
    initial_fx_usd     REAL    NOT NULL,
    location           TEXT    NOT NULL DEFAULT '',
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL,
    archived_at        TEXT
);

CREATE TABLE IF NOT EXISTS asset_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    INTEGER NOT NULL REFERENCES assets(id),
    type        TEXT    NOT NULL CHECK (type IN ('create', 'update', 'archive')),
    changes     TEXT,
    snapshot    TEXT    NOT NULL,
    created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_events_asset ON asset_events(asset_id, id);

CREATE TABLE IF NOT EXISTS quotes (
    provider     TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    price        REAL NOT NULL,
    currency     TEXT NOT NULL,
    price_usd    REAL NOT NULL,
    change_pct   REAL,
    market_time  TEXT,
    fetched_at   TEXT NOT NULL,
    error        TEXT,
    error_at     TEXT,
    PRIMARY KEY (provider, symbol)
);

CREATE TABLE IF NOT EXISTS price_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    price        REAL NOT NULL,
    currency     TEXT NOT NULL,
    price_usd    REAL NOT NULL,
    recorded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_history_symbol ON price_history(provider, symbol, id);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"""

ASSET_COLUMNS = frozenset({
    "kind", "provider", "symbol", "ticker", "name", "category", "quantity",
    "quote_currency", "manual_price", "initial_unit_price", "initial_currency",
    "initial_fx_usd", "location", "created_at", "updated_at", "archived_at",
})


class Database:
    """Fabrique de connexions SQLite (une connexion par opération, écritures sérialisées)."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.Lock()
        with self._write_lock:
            conn = self._connect()
            try:
                conn.execute("PRAGMA journal_mode = WAL")
                conn.executescript(_SCHEMA)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            finally:
                conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Transaction d'écriture atomique : tout est validé, ou rien."""
        with self._write_lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    yield conn
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                conn.execute("COMMIT")
            finally:
                conn.close()


# --------------------------------------------------------------------------- actifs

def insert_asset(conn: sqlite3.Connection, values: dict[str, Any]) -> int:
    _check_columns(values)
    columns = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    cursor = conn.execute(f"INSERT INTO assets ({columns}) VALUES ({marks})", tuple(values.values()))
    return int(cursor.lastrowid)


def update_asset(conn: sqlite3.Connection, asset_id: int, values: dict[str, Any]) -> None:
    if not values:
        return
    _check_columns(values)
    assignments = ", ".join(f"{column} = ?" for column in values)
    conn.execute(f"UPDATE assets SET {assignments} WHERE id = ?", (*values.values(), asset_id))


def get_asset(conn: sqlite3.Connection, asset_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    return dict(row) if row else None


def list_assets(conn: sqlite3.Connection, include_archived: bool = False) -> list[dict[str, Any]]:
    where = "" if include_archived else " WHERE archived_at IS NULL"
    return [dict(row) for row in conn.execute(f"SELECT * FROM assets{where} ORDER BY id")]


def _check_columns(values: dict[str, Any]) -> None:
    unknown = set(values) - ASSET_COLUMNS
    if unknown:
        raise ValueError(f"Colonnes inconnues : {sorted(unknown)}")


# --------------------------------------------------------------------------- journal

def insert_event(
    conn: sqlite3.Connection,
    asset_id: int,
    event_type: str,
    snapshot: dict[str, Any],
    changes: dict[str, Any] | None,
    at: str,
) -> int:
    cursor = conn.execute(
        "INSERT INTO asset_events (asset_id, type, changes, snapshot, created_at) VALUES (?, ?, ?, ?, ?)",
        (
            asset_id,
            event_type,
            json.dumps(changes, ensure_ascii=False) if changes else None,
            json.dumps(snapshot, ensure_ascii=False),
            at,
        ),
    )
    return int(cursor.lastrowid)


def list_events(conn: sqlite3.Connection, asset_id: int | None = None, limit: int = 300) -> list[dict[str, Any]]:
    if asset_id is None:
        rows = conn.execute("SELECT * FROM asset_events ORDER BY id DESC LIMIT ?", (limit,))
    else:
        rows = conn.execute(
            "SELECT * FROM asset_events WHERE asset_id = ? ORDER BY id DESC LIMIT ?", (asset_id, limit)
        )
    events = []
    for row in rows:
        event = dict(row)
        event["changes"] = json.loads(event["changes"]) if event["changes"] else None
        event["snapshot"] = json.loads(event["snapshot"])
        events.append(event)
    return events


# --------------------------------------------------------------------------- cours

def get_quotes(conn: sqlite3.Connection) -> dict[tuple[str, str], dict[str, Any]]:
    return {(row["provider"], row["symbol"]): dict(row) for row in conn.execute("SELECT * FROM quotes")}


def upsert_quote(conn: sqlite3.Connection, quote: dict[str, Any], at: str) -> None:
    conn.execute(
        """
        INSERT INTO quotes (provider, symbol, price, currency, price_usd, change_pct, market_time, fetched_at, error, error_at)
        VALUES (:provider, :symbol, :price, :currency, :price_usd, :change_pct, :market_time, :fetched_at, NULL, NULL)
        ON CONFLICT (provider, symbol) DO UPDATE SET
            price = excluded.price,
            currency = excluded.currency,
            price_usd = excluded.price_usd,
            change_pct = excluded.change_pct,
            market_time = excluded.market_time,
            fetched_at = excluded.fetched_at,
            error = NULL,
            error_at = NULL
        """,
        {
            "provider": quote["provider"],
            "symbol": quote["symbol"],
            "price": quote["price"],
            "currency": quote["currency"],
            "price_usd": quote["price_usd"],
            "change_pct": quote.get("change_pct"),
            "market_time": quote.get("market_time"),
            "fetched_at": at,
        },
    )


def mark_quote_error(conn: sqlite3.Connection, provider: str, symbol: str, message: str, at: str) -> None:
    """Garde le dernier cours connu mais signale l'échec du rafraîchissement."""
    conn.execute(
        "UPDATE quotes SET error = ?, error_at = ? WHERE provider = ? AND symbol = ?",
        (message, at, provider, symbol),
    )


def record_price(
    conn: sqlite3.Connection, quote: dict[str, Any], at: str, min_interval_seconds: int = 300
) -> bool:
    """Ajoute un point à l'historique des cours.

    Pour éviter de gonfler la base quand l'application reste ouverte, un point
    n'est ajouté que si le cours a changé et qu'au moins ``min_interval_seconds``
    se sont écoulées depuis le point précédent de cet instrument.
    """
    last = conn.execute(
        "SELECT price, price_usd, recorded_at FROM price_history WHERE provider = ? AND symbol = ? "
        "ORDER BY id DESC LIMIT 1",
        (quote["provider"], quote["symbol"]),
    ).fetchone()
    if last is not None:
        unchanged = last["price"] == quote["price"] and abs(last["price_usd"] - quote["price_usd"]) < 1e-12
        elapsed = (_parse_ts(at) - _parse_ts(last["recorded_at"])).total_seconds()
        if unchanged or elapsed < min_interval_seconds:
            return False
    conn.execute(
        "INSERT INTO price_history (provider, symbol, price, currency, price_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
        (quote["provider"], quote["symbol"], quote["price"], quote["currency"], quote["price_usd"], at),
    )
    return True


def count_price_history(conn: sqlite3.Connection, provider: str, symbol: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM price_history WHERE provider = ? AND symbol = ?", (provider, symbol)
    ).fetchone()
    return int(row[0])


# --------------------------------------------------------------------------- réglages

def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
