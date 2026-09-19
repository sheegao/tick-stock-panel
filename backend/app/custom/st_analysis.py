"""ST analysis extension: official daily disclosure feed."""

from __future__ import annotations

import asyncio
from datetime import date, datetime
from typing import Annotated
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.services.st_announcements import AnnouncementSourceUnavailableError
from app.services.st_archive import StArchive
from app.services.st_collection import archive_announcement, get_daily_st_announcements

EXTENSION_ID = "alphaquant.st-analysis"
EXTENSION_API_VERSION = 1
router = APIRouter(prefix="/api/st-analysis", tags=["ST analysis"])
_BEIJING = ZoneInfo("Asia/Shanghai")


@router.get("/announcements")
async def st_announcements(
    request: Request,
    day: Annotated[date | None, Query(alias="date")] = None,
    refresh: bool = False,
    include_all: bool = False,
) -> dict:
    today = datetime.now(_BEIJING).date()
    target = day or today
    if target > today:
        raise HTTPException(422, "公告日期不能晚于今天")
    if target < date(1990, 1, 1):
        raise HTTPException(422, "公告日期不能早于 1990 年")

    instruments = request.app.state.repo.get_instruments_asset("stock")
    data_dir = request.app.state.repo.store.data_dir
    if not instruments.is_empty() and {"symbol", "name"}.issubset(instruments.columns):
        names = {str(symbol).split(".", 1)[0]: str(name or "") for symbol, name in instruments.select("symbol", "name").iter_rows()}
        # Current instruments are evidence for today only, never for a historical as_of.
        await asyncio.to_thread(StArchive(data_dir).save_snapshot, today, names, "observed")
    try:
        # Coalesce normal simultaneous page reads before starting another full-market fetch.
        if not hasattr(request.app.state, "st_collection_lock"):
            request.app.state.st_collection_lock = asyncio.Lock()
        async with request.app.state.st_collection_lock:
            return await get_daily_st_announcements(target, data_dir=data_dir, refresh=refresh, include_all=include_all)
    except AnnouncementSourceUnavailableError as exc:
        raise HTTPException(502, str(exc)) from exc


class MembershipInterval(BaseModel):
    symbol: str = Field(pattern=r"^\d{6}$")
    start: date
    end: date | None = None
    name: str = Field(min_length=1, max_length=100)
    source: str = Field(min_length=1, max_length=500)


class MembershipImport(BaseModel):
    intervals: list[MembershipInterval] = Field(min_length=1, max_length=10000)


@router.post("/membership/import")
async def import_membership(request: Request, payload: MembershipImport):
    try:
        store = StArchive(request.app.state.repo.store.data_dir)
        await asyncio.to_thread(store.import_intervals, [item.model_dump(mode="json") for item in payload.intervals])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"imported": len(payload.intervals), "end_exclusive": True}


@router.post("/documents/{announcement_id}")
async def archive_document(request: Request, announcement_id: str, day: Annotated[date, Query(alias="date")]):
    try:
        return await archive_announcement(day, announcement_id, request.app.state.repo.store.data_dir)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "公告 PDF 下载失败, 请稍后重试") from exc


@router.get("/documents/{announcement_id}/pdf")
def local_pdf(request: Request, announcement_id: str):
    store = StArchive(request.app.state.repo.store.data_dir)
    path = store.pdf_path(announcement_id)
    if not path.is_file():
        raise HTTPException(404, "PDF 尚未归档")
    return FileResponse(path, media_type="application/pdf", filename=path.name, content_disposition_type="inline")


def setup(registrar) -> None:
    registrar.include_router(router)
