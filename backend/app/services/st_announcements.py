"""Daily material announcements for the current ST universe from CNINFO."""

from __future__ import annotations

import asyncio
import hashlib
import html
import re
import threading
import time
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

_CNINFO_QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
_CNINFO_STATIC_ROOT = "https://static.cninfo.com.cn/"
_CNINFO_HOME = "https://www.cninfo.com.cn/new/index"
_BEIJING = ZoneInfo("Asia/Shanghai")
_CACHE_TTL_SECONDS = 15 * 60
_MAX_PAGES_PER_KEYWORD = 2

# CNINFO full-text search has no batch filter for an arbitrary 200-stock universe.
# Querying a bounded material-event vocabulary avoids scanning every daily page and then
# filters the response against the locally authoritative ST universe.
_QUERY_KEYWORDS = (
    "风险警示",
    "退市",
    "重整",
    "破产",
    "立案",
    "行政处罚",
    "问询函",
    "异常波动",
    "停牌",
    "复牌",
    "业绩预告",
    "重大资产重组",
    "债务逾期",
    "诉讼",
    "控制权变更",
)

_CLASSIFICATION_RULES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "风险警示",
        "high",
        ("终止上市", "退市整理", "退市风险", "风险警示", "撤销风险警示"),
    ),
    ("重整进展", "high", ("预重整", "重整", "破产", "债权人")),
    ("监管事项", "high", ("立案", "行政处罚", "监管措施", "问询函", "纪律处分")),
    (
        "债务诉讼",
        "high",
        ("债务逾期", "资金占用", "违规担保", "诉讼", "仲裁"),
    ),
    (
        "资本运作",
        "high",
        ("重大资产重组", "控制权变更", "实际控制人变更", "股权转让"),
    ),
    ("交易提示", "medium", ("停牌", "复牌", "异常波动", "风险提示")),
    (
        "经营业绩",
        "medium",
        ("业绩预告", "业绩快报", "年度报告", "半年度报告", "审计意见", "非标审计"),
    ),
)

_TAG_RE = re.compile(r"<[^>]+>")
_cache_lock = threading.Lock()
_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


class AnnouncementSourceUnavailableError(RuntimeError):
    """CNINFO could not satisfy any of the bounded keyword queries."""


def _clean_text(value: object) -> str:
    return html.unescape(_TAG_RE.sub("", str(value or ""))).strip()


def classify_important_announcement(title: str) -> tuple[str, str] | None:
    """Return (category, importance) for material titles; unrelated titles are excluded."""
    clean_title = _clean_text(title)
    for category, importance, keywords in _CLASSIFICATION_RULES:
        if any(keyword in clean_title for keyword in keywords):
            return category, importance
    return None


def _announcement_url(value: object) -> str | None:
    path = str(value or "").strip().lstrip("/")
    if not path or "://" in path:
        return None
    return _CNINFO_STATIC_ROOT + path


def normalize_st_announcements(
    rows: list[dict[str, Any]],
    st_codes: set[str],
) -> list[dict[str, Any]]:
    """Filter CNINFO rows to the current ST universe, classify and deduplicate them."""
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        code = str(row.get("secCode") or "").strip()
        if code not in st_codes:
            continue
        title = _clean_text(row.get("announcementTitle"))
        classification = classify_important_announcement(title)
        if not title or classification is None:
            continue
        category, importance = classification
        timestamp_raw = row.get("announcementTime")
        try:
            timestamp_ms = int(timestamp_raw)
        except (TypeError, ValueError):
            timestamp_ms = 0
        announcement_id = str(row.get("announcementId") or "").strip()
        if not announcement_id:
            payload = f"{code}\0{title}\0{timestamp_ms}".encode()
            announcement_id = hashlib.sha256(payload).hexdigest()[:20]
        if announcement_id in seen:
            continue
        seen.add(announcement_id)
        published_at = (
            datetime.fromtimestamp(timestamp_ms / 1000, _BEIJING).isoformat()
            if timestamp_ms > 0
            else None
        )
        normalized.append(
            {
                "id": announcement_id,
                "symbol": code,
                "name": _clean_text(row.get("secName")),
                "title": title,
                "category": category,
                "importance": importance,
                "published_at": published_at,
                "url": _announcement_url(row.get("adjunctUrl")),
            }
        )

    importance_rank = {"high": 0, "medium": 1}
    normalized.sort(
        key=lambda item: (
            importance_rank.get(str(item["importance"]), 9),
            -(datetime.fromisoformat(item["published_at"]).timestamp() if item["published_at"] else 0),
        )
    )
    return normalized


async def _query_keyword(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    keyword: str,
    day: date,
) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    truncated = False
    day_range = f"{day.isoformat()}~{day.isoformat()}"
    async with semaphore:
        for page_number in range(1, _MAX_PAGES_PER_KEYWORD + 1):
            response = await client.post(
                _CNINFO_QUERY_URL,
                data={
                    "pageNum": str(page_number),
                    "pageSize": "30",
                    "column": "szse",
                    "tabName": "fulltext",
                    "plate": "",
                    "stock": "",
                    "searchkey": keyword,
                    "secid": "",
                    "category": "",
                    "trade": "",
                    "seDate": day_range,
                    "sortName": "",
                    "sortType": "",
                    "isHLtitle": "true",
                },
            )
            response.raise_for_status()
            payload = response.json()
            announcements = payload.get("announcements") or []
            if isinstance(announcements, list):
                rows.extend(item for item in announcements if isinstance(item, dict))
            total_pages = int(payload.get("totalpages") or 0)
            if page_number >= total_pages:
                break
            if page_number == _MAX_PAGES_PER_KEYWORD:
                truncated = True
    return rows, truncated


def _cache_key(day: date, st_codes: set[str]) -> tuple[str, str]:
    fingerprint = hashlib.sha256(",".join(sorted(st_codes)).encode()).hexdigest()[:16]
    return day.isoformat(), fingerprint


async def get_daily_st_announcements(day: date, st_codes: set[str]) -> dict[str, Any]:
    """Fetch and cache one day's material announcements for current ST security codes."""
    key = _cache_key(day, st_codes)
    now = time.monotonic()
    with _cache_lock:
        cached = _cache.get(key)
        if cached and now - cached[0] < _CACHE_TTL_SECONDS:
            return {**cached[1], "cached": True}

    if not st_codes:
        return {
            "date": day.isoformat(),
            "items": [],
            "partial": False,
            "cached": False,
            "source": {"name": "巨潮资讯", "url": _CNINFO_HOME},
            "retrieved_at": datetime.now(_BEIJING).isoformat(),
        }

    semaphore = asyncio.Semaphore(4)
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; TickStockPanel/0.2)",
        "Referer": "https://www.cninfo.com.cn/new/disclosure",
        "Origin": "https://www.cninfo.com.cn",
    }
    async with httpx.AsyncClient(
        headers=headers,
        timeout=httpx.Timeout(20, connect=5),
        trust_env=False,
        limits=httpx.Limits(max_connections=4),
    ) as client:
        results = await asyncio.gather(
            *(_query_keyword(client, semaphore, keyword, day) for keyword in _QUERY_KEYWORDS),
            return_exceptions=True,
        )

    all_rows: list[dict[str, Any]] = []
    failed_queries = 0
    truncated = False
    for result in results:
        if isinstance(result, BaseException):
            failed_queries += 1
            continue
        rows, was_truncated = result
        all_rows.extend(rows)
        truncated = truncated or was_truncated
    if failed_queries == len(_QUERY_KEYWORDS):
        raise AnnouncementSourceUnavailableError("巨潮资讯公告查询暂时不可用")

    payload: dict[str, Any] = {
        "date": day.isoformat(),
        "items": normalize_st_announcements(all_rows, st_codes),
        "partial": failed_queries > 0 or truncated,
        "cached": False,
        "source": {"name": "巨潮资讯", "url": _CNINFO_HOME},
        "retrieved_at": datetime.now(_BEIJING).isoformat(),
    }
    with _cache_lock:
        _cache[key] = (time.monotonic(), payload)
    return payload
