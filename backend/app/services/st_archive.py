"""Durable announcement metadata and explicitly dated ST membership evidence."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.price_limits import is_risk_warning_name


class StArchive:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "st_analysis"
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "archive.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS days (
                    day TEXT PRIMARY KEY, payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS snapshots (
                    day TEXT PRIMARY KEY, names TEXT NOT NULL, source TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS intervals (
                    symbol TEXT NOT NULL, start TEXT NOT NULL, end TEXT,
                    name TEXT NOT NULL, source TEXT NOT NULL,
                    PRIMARY KEY(symbol, start)
                );
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, payload TEXT NOT NULL
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def load_day(self, day: date) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT payload FROM days WHERE day=?", (day.isoformat(),)).fetchone()
        return json.loads(row[0]) if row else None

    def save_day(self, day: date, rows: list[dict], partial: bool, pages: int) -> dict:
        payload = {"rows": rows, "partial": partial, "pages": pages,
                   "retrieved_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT payload FROM days WHERE day=?", (day.isoformat(),)).fetchone()
            if previous and partial and not json.loads(previous[0])["partial"]:
                return json.loads(previous[0])
            if previous and partial:
                old_rows = json.loads(previous[0])["rows"]
                merged = {str(row.get("announcementId")): row for row in [*old_rows, *rows]}
                payload["rows"] = list(merged.values())
            db.execute("INSERT OR REPLACE INTO days VALUES (?,?)", (day.isoformat(), json.dumps(payload, ensure_ascii=False)))
        return payload

    def save_snapshot(self, day: date, names: dict[str, str], source: str):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT source FROM snapshots WHERE day=?", (day.isoformat(),)).fetchone()
            if old and old[0] == "verified" and source != "verified":
                return
            db.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)", (day.isoformat(), json.dumps(names, ensure_ascii=False), source))

    def import_intervals(self, rows: list[dict]):
        # Validate the entire batch before writing; end is exclusive (effective removal date).
        for row in rows:
            start = date.fromisoformat(row["start"])
            end = date.fromisoformat(row["end"]) if row.get("end") else None
            if end and end <= start:
                raise ValueError("结束日期必须晚于开始日期")
            if not row.get("source") or not row.get("name"):
                raise ValueError("必须填写证券简称及历史资料来源")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for row in rows:
                end = row.get("end")
                overlap = db.execute(
                    "SELECT 1 FROM intervals WHERE symbol=? AND start<>? AND (? IS NULL OR start<?) AND (end IS NULL OR end>?)",
                    (row["symbol"], row["start"], end, end, row["start"]),
                ).fetchone()
                if overlap:
                    raise ValueError("同一证券的历史区间不能重叠")
                db.execute("INSERT OR REPLACE INTO intervals VALUES (?,?,?,?,?)", (row["symbol"], row["start"], end, row["name"], row["source"]))

    def evidence(self, day: date) -> tuple[dict | None, dict[str, str]]:
        with self.connect() as db:
            snapshot = db.execute("SELECT names FROM snapshots WHERE day=?", (day.isoformat(),)).fetchone()
            intervals = db.execute("SELECT symbol,name FROM intervals WHERE start<=? AND (end IS NULL OR end>?)", (day.isoformat(), day.isoformat())).fetchall()
        return (json.loads(snapshot[0]) if snapshot else None, dict(intervals))

    def membership(self, day: date, symbol: str, announcement_name: str) -> tuple[bool, str]:
        return self.resolve_membership(self.evidence(day), symbol, announcement_name)

    @staticmethod
    def resolve_membership(evidence: tuple, symbol: str, announcement_name: str) -> tuple[bool, str]:
        snapshot, intervals = evidence
        if symbol in intervals:
            return is_risk_warning_name(intervals[symbol]), "verified_interval"
        if snapshot is not None and symbol in snapshot:
            return is_risk_warning_name(snapshot[symbol]), "snapshot"
        return is_risk_warning_name(announcement_name), "announcement_name"

    def document(self, announcement_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT payload FROM documents WHERE id=?", (announcement_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_document(self, announcement_id: str, payload: dict):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO documents VALUES (?,?)", (announcement_id, json.dumps(payload, ensure_ascii=False)))

    def document_statuses(self, ids: list[str]) -> dict[str, str]:
        statuses = {}
        with self.connect() as db:
            for start in range(0, len(ids), 500):
                batch = ids[start:start + 500]
                placeholders = ",".join("?" for _ in batch)
                for announcement_id, payload in db.execute(f"SELECT id,payload FROM documents WHERE id IN ({placeholders})", batch):
                    statuses[announcement_id] = json.loads(payload)["status"]
        return statuses

    def pdf_path(self, announcement_id: str) -> Path:
        folder = self.root / "pdf"
        folder.mkdir(exist_ok=True)
        # Remote IDs and user route parameters can never become filesystem paths.
        return folder / (hashlib.sha256(announcement_id.encode()).hexdigest() + ".pdf")
