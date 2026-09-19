"""TDX bridge v1: raw bars, single-event adjustment factors and quote snapshots.

Bridge units: yuan / hands (100 shares) / yuan. Quote source lacks a trade date.
Depth timestamps are explicitly the local bridge receive time, not exchange time.
"""

from __future__ import annotations

import logging
import math
import os
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from datetime import time as datetime_time
from urllib.parse import urlsplit

import httpx
import polars as pl

from app.data_providers.normalizer import normalize_adj_factors, normalize_daily

logger = logging.getLogger(__name__)
_SYMBOL = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
_UNITS = {"price": "yuan", "volume": "hands", "amount": "yuan", "depth_volume": "hands"}
_FEATURES = {"adj_factor", "daily", "depth5", "minute", "realtime"}
_MINUTE_COLS = ["symbol", "datetime", "open", "high", "low", "close", "volume", "amount"]
_AM_START = datetime_time(9, 30)
_AM_END = datetime_time(11, 30)
_PM_START = datetime_time(13)
_PM_END = datetime_time(15)
_CN_TZ = timezone(timedelta(hours=8))


def _url() -> str:
    url = os.getenv("TDX_BRIDGE_URL", "http://127.0.0.1:3020").rstrip("/")
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("TDX_BRIDGE_URL must be a local loopback HTTP URL")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path:
        raise ValueError("TDX_BRIDGE_URL must contain only scheme, host and port")
    return url


def availability() -> tuple[bool, str]:
    try:
        r = httpx.get(f"{_url()}/health", timeout=4, trust_env=False)
        if r.status_code != 200:
            return False, "TDX 桥接未就绪(服务器连接或行情探测失败)"
        data = r.json()
        features = data.get("features") if isinstance(data, dict) else None
        if (
            not isinstance(data, dict)
            or data.get("version") != 1
            or data.get("units") != _UNITS
            or not isinstance(features, list)
            or set(features) != _FEATURES
            or data.get("ready") is not True
            or data.get("adj_factor_kind") != "single_event_ratio"
            or data.get("depth_timestamp") != "local_receive"
        ):
            return False, "TDX 桥接协议/单位不兼容或未就绪"
        return True, "本机桥接已就绪; 日K/除权因子/分钟K/实时快照/五档, 五档为本机接收时间"
    except (httpx.HTTPError, ValueError) as exc:
        return False, f"TDX 桥接不可用: {exc}"


@dataclass
class _Config:
    name: str = "tdx"
    display_name: str = "通达信 TDX(本机桥接)"
    datasets: dict = field(
        default_factory=lambda: dict.fromkeys(
            ("daily", "adj_factor", "minute", "realtime", "depth5")
        )
    )
    path: None = None
    builtin: bool = True


def _number(row: dict, key: str, *, positive: bool = False) -> float:
    value = row.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"TDX missing/invalid numeric field: {key}")
    value = float(value)
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ValueError(f"TDX invalid numeric value: {key}")
    return value


def _beijing_wallclock(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(_CN_TZ).replace(tzinfo=None)


class TdxProvider:
    name = "tdx"
    builtin = True
    # Upstream caps 1-minute history at 24,000 bars; expose a conservative
    # 80-trading-day UI ceiling (80 * 240 < 24,000).
    minute_history_days = 80

    def __init__(self, client: httpx.Client | None = None):
        self.config = _Config()
        self._client = client or httpx.Client(base_url=_url(), timeout=120, trust_env=False)
        self._instruments: list[dict] | None = None
        self._instruments_at = 0.0

    def close(self):
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def _query(self, op: str, **kwargs) -> list[dict]:
        r = self._client.post("/query", json={"op": op, **kwargs})
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("TDX incompatible bridge response")
        rows = data.get("rows")
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("TDX malformed rows")
        return rows

    @staticmethod
    def _validate_symbols(symbols: list[str]):
        if any(not isinstance(s, str) or not _SYMBOL.fullmatch(s) for s in symbols):
            raise ValueError("TDX requires canonical six-digit .SH/.SZ/.BJ symbols")

    def iter_daily(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: str = "stock",
        on_chunk_done=None,
    ):
        if asset_type not in {"stock", "etf", "index"}:
            raise ValueError(f"TDX unsupported asset type: {asset_type}")
        self._validate_symbols(symbols)
        start = start_time.date() if start_time else None
        end = end_time.date() if end_time else None
        if start and end and start > end:
            raise ValueError("TDX start date is after end date")
        total = (len(symbols) + 4) // 5
        for i in range(total):
            batch = symbols[i * 5 : (i + 1) * 5]
            rows = self._query(
                "daily",
                symbols=batch,
                asset_type=asset_type,
                start=str(start) if start else "",
                end=str(end) if end else "",
            )
            accepted = []
            for row in rows:
                if row.get("symbol") not in batch:
                    raise ValueError("TDX unexpected daily symbol")
                if not isinstance(row.get("date"), str):
                    raise ValueError("TDX missing daily date")
                day = date.fromisoformat(row["date"])
                values = {
                    k: _number(row, k) for k in ("open", "high", "low", "close", "volume", "amount")
                }
                if values["high"] < max(values["open"], values["close"], values["low"]) or values[
                    "low"
                ] > min(values["open"], values["close"]):
                    raise ValueError("TDX invalid daily OHLC")
                if (start is None or day >= start) and (end is None or day <= end):
                    accepted.append({"symbol": row["symbol"], "date": day, **values})
            df = normalize_daily(accepted, source=self.name)
            if not df.is_empty():
                df = df.unique(subset=["symbol", "date"], keep="last").sort(["symbol", "date"])
            if on_chunk_done:
                on_chunk_done(i + 1, total)
            yield df

    def get_daily(self, symbols, start_time, end_time, asset_type="stock", on_chunk_done=None):
        frames = [
            df
            for df in self.iter_daily(symbols, start_time, end_time, asset_type, on_chunk_done)
            if not df.is_empty()
        ]
        return pl.concat(frames, how="diagonal_relaxed") if frames else pl.DataFrame()

    def get_adj_factors(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: str = "stock",
        on_chunk_done=None,
    ) -> pl.DataFrame:
        """Return non-cumulative, single-event ex-right/ex-dividend ratios."""
        schema = {"symbol": pl.String, "trade_date": pl.Date, "ex_factor": pl.Float64}
        if not symbols or asset_type != "stock":
            return pl.DataFrame(schema=schema)
        self._validate_symbols(symbols)
        start = start_time.date() if start_time else None
        end = end_time.date() if end_time else None
        if start and end and start > end:
            raise ValueError("TDX adjustment-factor start is after end")
        accepted: list[dict] = []
        total = (len(symbols) + 4) // 5
        for i in range(total):
            batch = symbols[i * 5 : (i + 1) * 5]
            rows = self._query(
                "adj_factors",
                symbols=batch,
                asset_type="stock",
                start=str(start) if start else "",
                end=str(end) if end else "",
            )
            for row in rows:
                if row.get("symbol") not in batch:
                    raise ValueError("TDX unexpected adjustment-factor symbol")
                if not isinstance(row.get("trade_date"), str):
                    raise ValueError("TDX missing adjustment-factor date")
                day = date.fromisoformat(row["trade_date"])
                factor = _number(row, "ex_factor", positive=True)
                if (start is None or day >= start) and (end is None or day <= end):
                    accepted.append(
                        {"symbol": row["symbol"], "trade_date": day, "ex_factor": factor}
                    )
            if on_chunk_done:
                on_chunk_done(i + 1, total)
        if not accepted:
            return pl.DataFrame(schema=schema)
        return (
            normalize_adj_factors(accepted, source=self.name)
            .unique(subset=["symbol", "trade_date"], keep="last")
            .sort(["symbol", "trade_date"])
        )

    def get_minute(
        self,
        symbols: list[str],
        start_time: datetime | None,
        end_time: datetime | None,
        asset_type: str = "stock",
        freq: str = "1m",
        on_chunk_done=None,
    ) -> pl.DataFrame:
        if asset_type not in {"stock", "etf", "index"}:
            raise ValueError(f"TDX unsupported asset type: {asset_type}")
        if freq != "1m":
            raise ValueError("TDX plugin currently exposes only 1m minute bars")
        self._validate_symbols(symbols)
        start_time = _beijing_wallclock(start_time)
        end_time = _beijing_wallclock(end_time)
        if start_time and end_time and start_time > end_time:
            raise ValueError("TDX minute start is after end")
        frames = []
        total = len(symbols)
        for i, symbol in enumerate(symbols):
            rows = self._query(
                "minute",
                symbols=[symbol],
                asset_type=asset_type,
                freq=freq,
                start=start_time.isoformat(timespec="seconds") if start_time else "",
                end=end_time.isoformat(timespec="seconds") if end_time else "",
            )
            accepted = []
            for row in rows:
                if row.get("symbol") != symbol or not isinstance(row.get("datetime"), str):
                    raise ValueError("TDX unexpected minute symbol/datetime")
                stamp = datetime.fromisoformat(row["datetime"])
                if stamp.tzinfo is not None:
                    raise ValueError("TDX minute datetime must be naive Beijing wallclock")
                minute = stamp.time()
                if not (_AM_START <= minute <= _AM_END or _PM_START <= minute <= _PM_END):
                    raise ValueError("TDX minute datetime is outside A-share sessions")
                values = {
                    key: _number(row, key)
                    for key in ("open", "high", "low", "close", "volume", "amount")
                }
                if values["high"] < max(values["open"], values["close"], values["low"]) or values[
                    "low"
                ] > min(values["open"], values["close"]):
                    raise ValueError("TDX invalid minute OHLC")
                if (start_time is None or stamp >= start_time) and (
                    end_time is None or stamp <= end_time
                ):
                    accepted.append({"symbol": symbol, "datetime": stamp, **values})
            if accepted:
                frames.append(pl.DataFrame(accepted).select(_MINUTE_COLS))
            if on_chunk_done:
                on_chunk_done(i + 1, total)
        if not frames:
            return pl.DataFrame()
        return (
            pl.concat(frames, how="diagonal_relaxed")
            .unique(subset=["symbol", "datetime"], keep="last")
            .sort(["symbol", "datetime"])
        )

    def get_instruments(self, asset_type="stock") -> list[dict]:
        if asset_type not in {"stock", "etf", "index"}:
            raise ValueError(f"TDX unsupported asset type: {asset_type}")
        if asset_type != "stock":
            return self._query("instruments", asset_type=asset_type)
        if self._instruments is not None and time.monotonic() - self._instruments_at < 3600:
            return list(self._instruments)
        rows = self._query("instruments", asset_type=asset_type)
        self._validate_symbols([r.get("symbol") for r in rows])
        if not rows:
            raise ValueError("TDX empty instrument universe; refusing full-market fetch")
        if any(not r.get("name") or r.get("type") != asset_type for r in rows):
            raise ValueError("TDX invalid instrument metadata")
        self._instruments = rows
        self._instruments_at = time.monotonic()
        return list(rows)

    def _quotes(self, symbols: list[str]) -> list[dict]:
        self._validate_symbols(symbols)
        result = []
        for offset in range(0, len(symbols), 80):
            batch = symbols[offset : offset + 80]
            rows = self._query("quotes", symbols=batch)
            if {r.get("symbol") for r in rows} != set(batch) or len(rows) != len(set(batch)):
                raise ValueError("TDX incomplete/unexpected quote batch")
            for row in rows:
                values = {
                    k: _number(row, k)
                    for k in ("last_price", "prev_close", "open", "high", "low", "volume", "amount")
                }
                prev = values["prev_close"]
                result.append(
                    {
                        **row,
                        **values,
                        "timestamp": None,
                        "change_amount": values["last_price"] - prev if prev else None,
                        "change_pct": values["last_price"] / prev - 1 if prev else None,
                        "amplitude": (values["high"] - values["low"]) / prev if prev else None,
                        "turnover_rate": None,
                    }
                )
        return result

    def get_depth_batch(self, symbols: list[str]) -> dict[str, dict]:
        symbols = list(dict.fromkeys(symbols))
        self._validate_symbols(symbols)
        result: dict[str, dict] = {}
        for offset in range(0, len(symbols), 80):
            batch = symbols[offset : offset + 80]
            rows = self._query("depth5", symbols=batch)
            if {row.get("symbol") for row in rows} != set(batch) or len(rows) != len(batch):
                raise ValueError("TDX incomplete/unexpected depth batch")
            for row in rows:
                parsed: dict[str, list] = {}
                for key in ("bid_prices", "ask_prices"):
                    values = row.get(key)
                    if not isinstance(values, list) or len(values) != 5:
                        raise ValueError(f"TDX invalid depth field: {key}")
                    parsed[key] = [_number({"value": value}, "value") for value in values]
                for key in ("bid_volumes", "ask_volumes"):
                    values = row.get(key)
                    if (
                        not isinstance(values, list)
                        or len(values) != 5
                        or any(
                            isinstance(value, bool) or not isinstance(value, int) or value < 0
                            for value in values
                        )
                    ):
                        raise ValueError(f"TDX invalid depth field: {key}")
                    parsed[key] = values
                timestamp = row.get("timestamp")
                if (
                    isinstance(timestamp, bool)
                    or not isinstance(timestamp, int)
                    or timestamp <= 0
                    or row.get("timestamp_provenance") != "local_receive"
                ):
                    raise ValueError("TDX invalid depth timestamp")
                source_time = row.get("source_time")
                if not isinstance(source_time, str):
                    raise ValueError("TDX invalid depth source time")
                symbol = row["symbol"]
                result[symbol] = {
                    "symbol": symbol,
                    **parsed,
                    "timestamp": timestamp,
                    "source_time": source_time,
                    "timestamp_provenance": "local_receive",
                }
        return result

    def get_realtime(self) -> list[dict]:
        try:
            instruments = self.get_instruments()
            rows = self._quotes([r["symbol"] for r in instruments])
            names = {r["symbol"]: r["name"] for r in instruments}
            return [{**r, "name": names[r["symbol"]]} for r in rows]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            logger.warning("TDX realtime failed; preserving old snapshot: %s", exc)
            return []

    def get_realtime_indices(self, symbols: list[str]) -> list[dict] | None:
        try:
            return self._quotes(symbols)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            logger.warning("TDX indices failed; preserving old cache: %s", exc)
            return None

    def test_dataset(self, dataset: str, symbols: list[str] | None = None) -> dict:
        symbols = symbols or ["600519.SH"]
        if dataset == "daily":
            now = datetime.now()
            df = self.get_daily(symbols, now - timedelta(days=30), now)
            rows, columns, preview = df.height, df.columns, df.head(5).to_dicts()
        elif dataset == "realtime":
            # Preview only requested symbols: never fetch the entire market for a test.
            data = self._quotes(symbols)
            rows, columns, preview = len(data), list(data[0]) if data else [], data[:5]
        elif dataset == "minute":
            now = datetime.now().replace(microsecond=0)
            df = self.get_minute(symbols, now - timedelta(days=30), now)
            rows, columns, preview = df.height, df.columns, df.head(5).to_dicts()
        elif dataset == "adj_factor":
            now = datetime.now()
            df = self.get_adj_factors(symbols, now - timedelta(days=365), now)
            rows, columns, preview = df.height, df.columns, df.head(5).to_dicts()
        elif dataset == "depth5":
            data = list(self.get_depth_batch(symbols).values())
            rows, columns, preview = len(data), list(data[0]) if data else [], data[:5]
        else:
            raise ValueError(f"TDX unsupported dataset: {dataset}")
        return dict(
            provider=self.name, dataset=dataset, rows=rows, columns=columns, preview=preview
        )
