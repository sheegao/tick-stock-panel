"""ST analysis extension: official daily disclosure feed."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from app.price_limits import is_risk_warning_name
from app.services.st_announcements import (
    AnnouncementSourceUnavailableError,
    get_daily_st_announcements,
)

EXTENSION_ID = "alphaquant.st-analysis"
EXTENSION_API_VERSION = 1
router = APIRouter(prefix="/api/st-analysis", tags=["ST analysis"])
_BEIJING = ZoneInfo("Asia/Shanghai")


@router.get("/announcements")
async def st_announcements(
    request: Request,
    day: Annotated[date | None, Query(alias="date")] = None,
) -> dict:
    today = datetime.now(_BEIJING).date()
    target = day or today
    if target > today:
        raise HTTPException(422, "公告日期不能晚于今天")
    if target < today - timedelta(days=366):
        raise HTTPException(422, "公告日期最多回看 366 天")

    instruments = request.app.state.repo.get_instruments_asset("stock")
    if instruments.is_empty() or not {"symbol", "name"}.issubset(instruments.columns):
        st_codes: set[str] = set()
    else:
        st_codes = {
            str(symbol).split(".", 1)[0]
            for symbol, name in instruments.select("symbol", "name").iter_rows()
            if is_risk_warning_name(name)
        }
    try:
        return await get_daily_st_announcements(target, st_codes)
    except AnnouncementSourceUnavailableError as exc:
        raise HTTPException(502, str(exc)) from exc


def setup(registrar) -> None:
    registrar.include_router(router)
