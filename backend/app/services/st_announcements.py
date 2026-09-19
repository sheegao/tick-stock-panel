"""Daily material announcements for the current ST universe from CNINFO."""

from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

_CNINFO_QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
_CNINFO_STATIC_ROOT = "https://static.cninfo.com.cn/"
_CNINFO_HOME = "https://www.cninfo.com.cn/new/index"
_BEIJING = ZoneInfo("Asia/Shanghai")
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
    if not re.fullmatch(r"finalpage/[A-Za-z0-9_./-]+\.[Pp][Dd][Ff]", path) or ".." in path:
        return None
    return _CNINFO_STATIC_ROOT + path


def normalize_st_announcements(
    rows: list[dict[str, Any]],
    st_codes: set[str],
    *, include_all: bool = False,
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
        if not title or (classification is None and not include_all):
            continue
        category, importance = classification or ("其他公告", "low")
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
