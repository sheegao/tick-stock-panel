from types import SimpleNamespace

import polars as pl

from app.api import screener
from app.services.st_announcements import (
    classify_important_announcement,
    normalize_st_announcements,
)


def test_market_snapshot_exposes_existing_limit_and_momentum_fields(monkeypatch):
    frame = pl.DataFrame(
        {
            "symbol": ["000001.SZ"],
            "name": ["ST测试"],
            "close": [3.21],
            "signal_limit_up": [True],
            "signal_limit_down": [False],
            "signal_broken_limit_up": [False],
            "signal_limit_down_recovery": [False],
            "consecutive_limit_downs": [0],
            "momentum_20d": [0.123],
            "annual_vol_20d": [0.456],
        }
    )

    class FakeScreenerService:
        def __init__(self, _repo):
            pass

        def latest_date(self):
            return "2026-09-15"

        def _load_enriched_for_date(self, _as_of):
            return frame

    monkeypatch.setattr(screener, "ScreenerService", FakeScreenerService)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(repo=object())))

    payload = screener.market_snapshot(request)

    assert payload["rows"] == [
        {
            "symbol": "000001.SZ",
            "name": "ST测试",
            "close": 3.21,
            "signal_limit_up": True,
            "signal_limit_down": False,
            "signal_broken_limit_up": False,
            "signal_limit_down_recovery": False,
            "consecutive_limit_downs": 0,
            "momentum_20d": 0.123,
            "annual_vol_20d": 0.456,
        }
    ]


def test_announcement_classification_prefers_material_risk_categories():
    assert classify_important_announcement("关于公司股票可能被终止上市的风险提示公告") == (
        "风险警示",
        "high",
    )
    assert classify_important_announcement("关于公开招募重整投资人的公告") == (
        "重整进展",
        "high",
    )
    assert classify_important_announcement("股票交易异常波动公告") == (
        "交易提示",
        "medium",
    )
    assert classify_important_announcement("关于召开股东大会的通知") is None


def test_normalize_announcements_filters_current_st_codes_and_deduplicates():
    rows = [
        {
            "announcementId": "a1",
            "secCode": "000001",
            "secName": "*ST甲",
            "announcementTitle": "关于公司<em>重整</em>进展的公告",
            "announcementTime": 1789470000000,
            "adjunctUrl": "finalpage/2026-09-15/a1.PDF",
        },
        {
            "announcementId": "a1",
            "secCode": "000001",
            "secName": "*ST甲",
            "announcementTitle": "关于公司<em>重整</em>进展的公告",
            "announcementTime": 1789470000000,
            "adjunctUrl": "finalpage/2026-09-15/a1.PDF",
        },
        {
            "announcementId": "a2",
            "secCode": "000002",
            "secName": "普通公司",
            "announcementTitle": "股票交易异常波动公告",
            "announcementTime": 1789460000000,
            "adjunctUrl": "finalpage/2026-09-15/a2.PDF",
        },
    ]

    normalized = normalize_st_announcements(rows, {"000001"})

    assert len(normalized) == 1
    assert normalized[0]["id"] == "a1"
    assert normalized[0]["title"] == "关于公司重整进展的公告"
    assert normalized[0]["category"] == "重整进展"
    assert normalized[0]["url"] == "https://static.cninfo.com.cn/finalpage/2026-09-15/a1.PDF"
