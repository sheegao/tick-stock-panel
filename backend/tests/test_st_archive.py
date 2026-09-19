from datetime import date

from app.services.st_archive import StArchive


def test_archive_survives_restart_and_preserves_complete_result(tmp_path):
    store = StArchive(tmp_path)
    store.save_day(date(2026, 9, 15), [{"announcementId": "1"}], False, 1)
    store.save_day(date(2026, 9, 15), [], True, 2)
    payload = StArchive(tmp_path).load_day(date(2026, 9, 15))
    assert payload["rows"] == [{"announcementId": "1"}]
    assert payload["partial"] is False


def test_partial_refresh_merges_previously_collected_ids(tmp_path):
    store = StArchive(tmp_path)
    day = date(2026, 9, 15)
    store.save_day(day, [{"announcementId": "1"}], True, 1)
    store.save_day(day, [{"announcementId": "2"}], True, 1)
    assert len(store.load_day(day)["rows"]) == 2


def test_overlapping_import_is_atomic(tmp_path):
    import pytest
    store = StArchive(tmp_path)
    with pytest.raises(ValueError, match="重叠"):
        store.import_intervals([
            {"symbol": "000001", "start": "2026-01-01", "end": "2026-06-01", "name": "ST测试", "source": "公告"},
            {"symbol": "000001", "start": "2026-02-01", "end": "2026-07-01", "name": "ST测试", "source": "公告"},
        ])
    assert store.evidence(date(2026, 3, 1))[1] == {}


def test_history_is_not_backdated_from_latest_names(tmp_path):
    store = StArchive(tmp_path)
    store.save_snapshot(date(2026, 9, 16), {"000001": "ST测试"}, "observed")
    assert store.membership(date(2026, 9, 15), "000001", "普通公司") == (False, "announcement_name")
    assert store.membership(date(2026, 9, 16), "000001", "普通公司") == (True, "snapshot")


def test_verified_intervals_include_start_and_exclude_end(tmp_path):
    store = StArchive(tmp_path)
    store.import_intervals([{"symbol": "000001", "start": "2026-01-01", "end": "2026-06-01", "name": "*ST测试", "source": "公告核验"}])
    assert store.membership(date(2026, 1, 1), "000001", "普通公司") == (True, "verified_interval")
    assert store.membership(date(2026, 6, 1), "000001", "普通公司") == (False, "announcement_name")


def test_non_st_interval_overrides_disclosure_name(tmp_path):
    store = StArchive(tmp_path)
    store.import_intervals([{"symbol": "000001", "start": "2026-06-01", "end": None, "name": "测试股份", "source": "摘帽公告"}])
    assert store.membership(date(2026, 6, 2), "000001", "ST旧名") == (False, "verified_interval")


def test_snapshot_does_not_override_user_verified_data(tmp_path):
    store = StArchive(tmp_path)
    day = date(2026, 9, 16)
    store.save_snapshot(day, {"000001": "普通公司"}, "verified")
    store.save_snapshot(day, {"000001": "ST旧名"}, "observed")
    assert store.membership(day, "000001", "ST旧名") == (False, "snapshot")
