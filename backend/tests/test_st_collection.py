from datetime import date
from types import SimpleNamespace

import httpx
import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.custom import st_analysis
from app.services import st_collection
from app.services.st_announcements import (
    AnnouncementSourceUnavailableError,
    normalize_st_announcements,
)
from app.services.st_archive import StArchive
from app.services.st_collection import (
    CninfoAnnouncementSource,
    archive_announcement,
    get_daily_st_announcements,
)


def row(number, name="ST测试", title="普通会议通知"):
    return {"announcementId": str(number), "secCode": "000001", "secName": name,
            "announcementTitle": title, "announcementTime": 1789423200000,
            "adjunctUrl": "finalpage/2026-09-15/test.PDF"}


async def test_source_reads_rounded_down_last_page(monkeypatch):
    requested = []

    def respond(request):
        from urllib.parse import parse_qs
        params = parse_qs(request.content.decode(), keep_blank_values=True)
        number = int(params["pageNum"][0])
        requested.append(number)
        assert params["searchkey"] == [""]
        rows = [row(n) for n in range((number - 1) * 30, min(number * 30, 31))]
        return httpx.Response(200, json={"announcements": rows, "totalAnnouncement": 31, "totalpages": 1})

    monkeypatch.setattr(st_collection, "announcement_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    rows, partial, pages = await CninfoAnnouncementSource().fetch_day(date(2026, 9, 15))
    assert requested == [1, 2]
    assert len(rows) == 31
    assert pages == 2
    assert partial is False


async def test_source_missing_page_is_partial(monkeypatch):
    def respond(request):
        if b"pageNum=2" in request.content:
            return httpx.Response(503)
        return httpx.Response(200, json={"announcements": [row(1)], "totalAnnouncement": 31, "totalpages": 2})
    monkeypatch.setattr(st_collection, "announcement_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    rows, partial, _ = await CninfoAnnouncementSource().fetch_day(date(2026, 9, 15))
    assert len(rows) == 1
    assert partial is True


async def test_archive_cache_survives_restart_and_membership_changes(tmp_path):
    day = date(2026, 9, 15)
    calls = []

    class Source:
        async def fetch_day(self, _day):
            calls.append(_day)
            return [row(1), row(2, title="公司重整公告")], False, 1

    first = await get_daily_st_announcements(day, data_dir=tmp_path, include_all=True, source=Source())
    assert len(first["items"]) == 2
    assert first["history_warning"] is True
    important = await get_daily_st_announcements(day, data_dir=tmp_path, source=Source())
    assert [item["id"] for item in important["items"]] == ["2"]
    assert len(calls) == 1
    StArchive(tmp_path).import_intervals([{"symbol": "000001", "start": "2026-09-01", "end": None, "name": "已摘帽股份", "source": "核验资料"}])
    changed = await get_daily_st_announcements(day, data_dir=tmp_path, include_all=True, source=Source())
    assert changed["items"] == []
    assert len(calls) == 1


async def test_offline_falls_back_to_persisted_data_and_never_overwrites(tmp_path):
    day = date(2026, 9, 15)
    StArchive(tmp_path).save_day(day, [row(1)], False, 1)

    class Offline:
        async def fetch_day(self, _day):
            raise AnnouncementSourceUnavailableError("offline")

    payload = await get_daily_st_announcements(day, data_dir=tmp_path, refresh=True, include_all=True, source=Offline())
    assert payload["stale"] is True
    assert len(payload["items"]) == 1
    with pytest.raises(AnnouncementSourceUnavailableError):
        await get_daily_st_announcements(date(2026, 9, 14), data_dir=tmp_path, source=Offline())


def test_full_list_preserves_unclassified_titles_and_rejects_unsafe_pdf_paths():
    assert normalize_st_announcements([row(1)], {"000001"}) == []
    unsafe = row(1)
    unsafe["adjunctUrl"] = "finalpage/../../secret.PDF"
    item = normalize_st_announcements([unsafe], {"000001"}, include_all=True)[0]
    assert item["importance"] == "low"
    assert item["url"] is None


async def test_pdf_requires_collected_id_and_validates_content(tmp_path, monkeypatch):
    with pytest.raises(ValueError):
        await archive_announcement(date(2026, 9, 15), "missing", tmp_path)
    StArchive(tmp_path).save_day(date(2026, 9, 15), [row(1)], False, 1)
    monkeypatch.setattr(st_collection, "announcement_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=b"not a PDF"))))
    with pytest.raises(ValueError, match="PDF"):
        await archive_announcement(date(2026, 9, 15), "1", tmp_path)
    assert not StArchive(tmp_path).pdf_path("1").is_file()


async def test_blank_pdf_is_archived_but_never_claims_text_extraction_success(tmp_path, monkeypatch):
    from io import BytesIO

    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    stream = BytesIO()
    writer.write(stream)
    calls = []

    def respond(_request):
        calls.append(1)
        return httpx.Response(200, content=stream.getvalue())

    store = StArchive(tmp_path)
    store.save_day(date(2026, 9, 15), [row(1)], False, 1)
    monkeypatch.setattr(st_collection, "announcement_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    first = await archive_announcement(date(2026, 9, 15), "1", tmp_path)
    assert first["status"] == "needs_ocr"
    assert first["text"] == ""
    assert store.pdf_path("1").read_bytes() == stream.getvalue()
    second = await archive_announcement(date(2026, 9, 15), "1", tmp_path)
    assert second["sha256"] == first["sha256"]
    assert len(calls) == 1


def test_api_no_data_dates_import_and_errors(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(st_analysis.router)
    app.state.repo = SimpleNamespace(store=SimpleNamespace(data_dir=tmp_path), get_instruments_asset=lambda _asset: pl.DataFrame())
    client = TestClient(app)
    assert client.get("/api/st-analysis/announcements?date=2100-01-01").status_code == 422
    assert client.get("/api/st-analysis/announcements?date=1989-01-01").status_code == 422
    payload = {"intervals": [{"symbol": "000001", "start": "2020-01-01", "end": "2020-02-01", "name": "ST测试", "source": "核验公告"}]}
    assert client.post("/api/st-analysis/membership/import", json=payload).json()["imported"] == 1
    payload["intervals"][0]["end"] = "2019-01-01"
    assert client.post("/api/st-analysis/membership/import", json=payload).status_code == 422
    assert client.get("/api/st-analysis/documents/missing/pdf").status_code == 404
    assert client.post("/api/st-analysis/documents/missing?date=2026-09-15").status_code == 422

    async def offline(*_args, **_kwargs):
        raise AnnouncementSourceUnavailableError("公告源不可用")
    monkeypatch.setattr(st_analysis, "get_daily_st_announcements", offline)
    assert client.get("/api/st-analysis/announcements?date=2026-09-15").status_code == 502
