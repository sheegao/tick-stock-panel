"""Unfiltered daily disclosure collection, durable historical filtering and PDF archive."""
from __future__ import annotations

import asyncio
import hashlib
import math
import os
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from app.services.st_announcements import (
    AnnouncementSourceUnavailableError,
    _announcement_url,
    _clean_text,
    normalize_st_announcements,
)
from app.services.st_archive import StArchive

_BEIJING = ZoneInfo("Asia/Shanghai")
_MAX_DAILY_PAGES = 500
_SOURCE_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"


def announcement_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.cninfo.com.cn/new/disclosure", "Origin": "https://www.cninfo.com.cn"},
        timeout=httpx.Timeout(20, connect=5), trust_env=False,
        limits=httpx.Limits(max_connections=4), follow_redirects=False,
    )


class CninfoAnnouncementSource:
    """Adapter contract: fetch_day(day) -> (normalized supplier rows, partial, pages).

    The CNINFO all-market query is independent of the market price provider.
    Tests and alternative sources inject an adapter with this same contract.
    """
    async def fetch_day(self, day: date) -> tuple[list[dict], bool, int]:
        started = asyncio.get_running_loop().time()
        async with announcement_client() as client:
            async def page(number: int) -> dict:
                for attempt in range(3):
                    try:
                        response = await client.post(_SOURCE_URL, data={
                            "pageNum": str(number), "pageSize": "30", "column": "szse",
                            "tabName": "fulltext", "plate": "", "stock": "", "searchkey": "",
                            "secid": "", "category": "", "trade": "",
                            "seDate": f"{day.isoformat()}~{day.isoformat()}",
                            "sortName": "", "sortType": "", "isHLtitle": "false",
                        })
                        response.raise_for_status()
                        payload = response.json()
                        if not isinstance(payload, dict) or not isinstance(payload.get("announcements"), (list, type(None))) or "totalAnnouncement" not in payload:
                            raise ValueError("公告源响应结构异常")
                        if int(payload["totalAnnouncement"] or 0) < 0 or int(payload.get("totalpages") or 0) < 0:
                            raise ValueError("公告源数量字段异常")
                        return payload
                    except (httpx.HTTPError, ValueError):
                        if attempt == 2:
                            raise
                        await asyncio.sleep(0.3 * (attempt + 1))
                raise AssertionError("unreachable")

            try:
                first = await page(1)
            except (httpx.HTTPError, ValueError) as exc:
                raise AnnouncementSourceUnavailableError("巨潮资讯公告查询暂时不可用") from exc
            total = int(first.get("totalAnnouncement") or 0)
            # Live totalpages may be rounded down: ceil total rows as a second authority.
            pages = max(1, int(first.get("totalpages") or 0), math.ceil(total / 30))
            partial = pages > _MAX_DAILY_PAGES
            rows = list(first.get("announcements") or [])
            successful = 1
            for start in range(2, min(pages, _MAX_DAILY_PAGES) + 1, 4):
                if asyncio.get_running_loop().time() - started >= 180:
                    partial = True
                    break
                results = await asyncio.gather(*(page(n) for n in range(start, min(start + 4, pages + 1, _MAX_DAILY_PAGES + 1))), return_exceptions=True)
                for result in results:
                    if isinstance(result, BaseException):
                        partial = True
                    else:
                        rows.extend(result.get("announcements") or [])
                        successful += 1
            unique = {str(row.get("announcementId")): row for row in rows if isinstance(row, dict) and row.get("announcementId")}
            return list(unique.values()), partial or len(unique) < total, successful


async def get_daily_st_announcements(
    day: date, *, data_dir: Path, refresh: bool = False, include_all: bool = False, source=None,
) -> dict:
    """Persist all daily rows; re-evaluate dated membership on each read (no membership cache)."""
    store = StArchive(data_dir)
    saved = await asyncio.to_thread(store.load_day, day)
    cached = False
    stale = False
    now = datetime.now(_BEIJING)
    if saved:
        age = (now - datetime.fromisoformat(saved["retrieved_at"])).total_seconds()
        cached = not refresh and not saved["partial"] and (age < 900 or day < now.date() - timedelta(days=1))
    if not cached:
        try:
            rows, partial, pages = await (source or CninfoAnnouncementSource()).fetch_day(day)
            result = await asyncio.to_thread(store.save_day, day, rows, partial, pages)
            stale = partial and not result["partial"]
            saved = result
        except AnnouncementSourceUnavailableError:
            if saved is None:
                raise
            stale = True
            cached = True
    evidence = await asyncio.to_thread(store.evidence, day)
    included = []
    bases: dict[str, str] = {}
    for row in saved["rows"]:
        code = str(row.get("secCode") or "")
        if len(code) != 6 or not code.isdigit():
            continue
        is_st, basis = store.resolve_membership(evidence, code, _clean_text(row.get("secName")))
        if is_st:
            included.append(row)
            bases[code] = basis
    all_items = normalize_st_announcements(included, set(bases), include_all=True)
    items = all_items if include_all else [item for item in all_items if item["importance"] != "low"]
    statuses = await asyncio.to_thread(store.document_statuses, [item["id"] for item in items])
    for item in items:
        item["membership_basis"] = bases[item["symbol"]]
        item["document_status"] = statuses.get(item["id"], "not_downloaded")
    return {
        "date": day.isoformat(), "items": items, "partial": saved["partial"],
        "stale": stale, "cached": cached, "persisted": True,
        "market_announcement_count": len(saved["rows"]), "st_announcement_count": len(all_items),
        "pages": saved["pages"], "snapshot_available": evidence[0] is not None,
        "history_warning": any(value == "announcement_name" for value in bases.values()) or evidence[0] is None,
        "source": {"name": "巨潮资讯", "url": "https://www.cninfo.com.cn/new/index"},
        "retrieved_at": saved["retrieved_at"],
    }


async def archive_announcement(day: date, announcement_id: str, data_dir: Path) -> dict:
    """Only download a previously collected attachment; never accept arbitrary external URLs."""
    store = StArchive(data_dir)
    saved = await asyncio.to_thread(store.load_day, day)
    row = next((row for row in (saved or {}).get("rows", []) if str(row.get("announcementId")) == announcement_id), None)
    if row is None:
        raise ValueError("请先采集该日期的公告")
    url = _announcement_url(row.get("adjunctUrl"))
    if not url:
        raise ValueError("公告附件地址无效")
    previous = await asyncio.to_thread(store.document, announcement_id)
    path = store.pdf_path(announcement_id)
    if previous and previous["status"] == "ready" and path.is_file():
        return previous
    if not path.is_file():
        async with announcement_client() as client, client.stream("GET", url) as response:
            response.raise_for_status()
            content = bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content) > 10 * 1024 * 1024:
                    raise ValueError("PDF 超过 10 MB, 保留远程原文链接")
        if not content.startswith(b"%PDF-"):
            raise ValueError("附件不是有效 PDF")
        await asyncio.to_thread(_write_pdf, path, bytes(content))
    text, status = await asyncio.to_thread(_extract_pdf_text, path)
    payload = {"id": announcement_id, "status": status, "text": text,
               "sha256": await asyncio.to_thread(_pdf_hash, path),
               "archived_at": datetime.now(_BEIJING).isoformat(), "url": url}
    await asyncio.to_thread(store.save_document, announcement_id, payload)
    return payload


def _write_pdf(path: Path, content: bytes):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, suffix=".tmp") as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _pdf_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _extract_pdf_text(path: Path) -> tuple[str, str]:
    try:
        from pypdf import PdfReader
    except ImportError:
        return "", "parser_unavailable"
    try:
        reader = PdfReader(path)
        if len(reader.pages) > 100:
            return "", "text_limit"
        parts = []
        length = 0
        for page in reader.pages:
            contents = page.get_contents()
            if contents and len(contents.get_data()) > 5 * 1024 * 1024:
                return "", "text_limit"
            text = page.extract_text() or ""
            length += len(text)
            if length > 500_000:
                return "", "text_limit"
            parts.append(text)
        text = "\n".join(parts).strip()
        return text, "ready" if text else "needs_ocr"
    except Exception:  # A damaged attachment must not break market analysis.
        return "", "parse_failed"
