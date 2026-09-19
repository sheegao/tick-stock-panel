from datetime import UTC, date, datetime

import httpx
import polars as pl
import pytest
import yaml

from app.plugins.tdx.provider import TdxProvider, availability


def provider(handler):
    return TdxProvider(
        client=httpx.Client(
            base_url="http://127.0.0.1:3020",
            transport=httpx.MockTransport(handler),
        )
    )


def response(rows):
    return httpx.Response(200, json={"version": 1, "rows": rows})


def test_daily_contract_and_range():
    def handle(request):
        assert request.url.path == "/query"
        return response(
            [
                dict(
                    symbol="600519.SH",
                    date="2026-09-17",
                    open=10,
                    high=12,
                    low=9,
                    close=11,
                    volume=123,
                    amount=45678,
                ),
                dict(
                    symbol="600519.SH",
                    date="2026-09-18",
                    open=11,
                    high=12,
                    low=10,
                    close=12,
                    volume=234,
                    amount=56789,
                ),
            ]
        )

    with provider(handle) as p:
        df = p.get_daily(["600519.SH"], datetime(2026, 9, 18), datetime(2026, 9, 18))
    assert df.height == 1
    assert df["volume"][0] == 234  # Bridge already emits hands; never divide again.
    assert df["amount"][0] == 56789
    assert str(df["date"][0]) == "2026-09-18"


def test_daily_empty_and_progress():
    progress = []
    with provider(lambda _: response([])) as p:
        assert p.get_daily([], None, None).is_empty()
        assert p.get_daily(
            ["600519.SH"] * 11, None, None, on_chunk_done=lambda a, b: progress.append((a, b))
        ).is_empty()
    assert progress == [(1, 3), (2, 3), (3, 3)]


@pytest.mark.parametrize(
    "rows",
    [
        [{"symbol": "600519.SH"}],
        [
            dict(
                symbol="000001.SZ",
                date="2026-09-18",
                open=10,
                high=11,
                low=9,
                close=10,
                volume=1,
                amount=2,
            )
        ],
        [
            dict(
                symbol="600519.SH",
                date="wrong",
                open=10,
                high=11,
                low=9,
                close=10,
                volume=1,
                amount=2,
            )
        ],
        [
            dict(
                symbol="600519.SH",
                date="2026-09-18",
                open=10,
                high=9,
                low=8,
                close=10,
                volume=1,
                amount=2,
            )
        ],
    ],
)
def test_bad_daily_is_rejected(rows):
    with provider(lambda _: response(rows)) as p, pytest.raises(ValueError):
        p.get_daily(["600519.SH"], None, None)


def test_daily_network_error_is_not_silent_partial_success():
    with (
        provider(lambda _: httpx.Response(503, json={"error": "offline"})) as p,
        pytest.raises(httpx.HTTPStatusError),
    ):
        p.get_daily(["600519.SH"], None, None)


def test_quotes_contract_missing_source_timestamp():
    with provider(
        lambda _: response(
            [
                dict(
                    symbol="600519.SH",
                    last_price=11,
                    prev_close=10,
                    open=10,
                    high=11,
                    low=9,
                    volume=100,
                    amount=100000,
                    source_time="150000",
                )
            ]
        )
    ) as p:
        rows = p._quotes(["600519.SH"])
    assert rows[0]["change_pct"] == pytest.approx(0.1)
    assert rows[0]["amplitude"] == pytest.approx(0.2)
    assert rows[0]["volume"] == 100
    assert rows[0]["timestamp"] is None  # Upstream quote has no trade date.
    assert rows[0]["turnover_rate"] is None


def test_quotes_full_failure_keeps_old_cache_and_index_failure_is_none():
    def handle(request):
        if b'"instruments"' in request.content:
            return response(
                [
                    dict(
                        symbol="600519.SH",
                        name="test",
                        code="600519",
                        exchange="SH",
                        region="CN",
                        type="stock",
                        ext={},
                    )
                ]
            )
        raise httpx.ConnectError("offline", request=request)

    with provider(handle) as p:
        assert p.get_realtime() == []
        assert p.get_realtime_indices(["000001.SH"]) is None


def test_capabilities_and_unsupported():
    with provider(lambda _: response([])) as p:
        assert set(p.config.datasets) == {"adj_factor", "daily", "depth5", "minute", "realtime"}
        assert p.minute_history_days == 80
        with pytest.raises(ValueError):
            p.test_dataset("financial")
        with pytest.raises(ValueError):
            p.get_daily(["600519.SH"], None, None, asset_type="bond")


def test_adj_factor_contract_range_batch_and_progress():
    progress = []

    def handle(request):
        payload = __import__("json").loads(request.content)
        assert payload["op"] == "adj_factors"
        return response(
            [
                dict(symbol=symbol, trade_date="2026-09-17", ex_factor=1.0526315789473684)
                for symbol in payload["symbols"]
            ]
            + [dict(symbol=payload["symbols"][0], trade_date="2026-09-01", ex_factor=1.01)]
        )

    symbols = [f"{i:06d}.SZ" for i in range(11)]
    with provider(handle) as p:
        df = p.get_adj_factors(
            symbols,
            datetime(2026, 9, 10),
            datetime(2026, 9, 18),
            on_chunk_done=lambda a, b: progress.append((a, b)),
        )
    assert df.height == 11
    assert df.schema == {
        "symbol": pl.String,
        "trade_date": pl.Date,
        "ex_factor": pl.Float64,
    }
    assert set(df["trade_date"]) == {date(2026, 9, 17)}
    assert progress == [(1, 3), (2, 3), (3, 3)]


@pytest.mark.parametrize(
    "row",
    [
        dict(symbol="000001.SZ", trade_date="2026-09-17", ex_factor=1.1),
        dict(symbol="600519.SH", trade_date="bad", ex_factor=1.1),
        dict(symbol="600519.SH", trade_date="2026-09-17", ex_factor=0),
        dict(symbol="600519.SH", trade_date="2026-09-17", ex_factor=True),
        dict(symbol="600519.SH", trade_date="2026-09-17", ex_factor=float("nan")),
    ],
)
def test_bad_adj_factor_is_rejected(row):
    with provider(lambda _: response([row])) as p, pytest.raises(ValueError):
        p.get_adj_factors(["600519.SH"], None, None)


def test_adj_factor_only_supports_stock_and_empty_input():
    with provider(lambda _: response([])) as p:
        assert p.get_adj_factors([], None, None).is_empty()
        assert p.get_adj_factors(["510300.SH"], None, None, asset_type="etf").is_empty()


def test_depth5_contract_units_timestamp_and_batching():
    calls = []

    def handle(request):
        payload = __import__("json").loads(request.content)
        calls.append(payload["symbols"])
        assert payload["op"] == "depth5"
        return response(
            [
                dict(
                    symbol=symbol,
                    bid_prices=[10.0, 9.99, 9.98, 9.97, 9.96],
                    ask_prices=[10.01, 10.02, 10.03, 10.04, 10.05],
                    bid_volumes=[11, 12, 13, 14, 15],
                    ask_volumes=[21, 22, 23, 24, 25],
                    timestamp=1789714862345,
                    source_time="150000",
                    timestamp_provenance="local_receive",
                )
                for symbol in payload["symbols"]
            ]
        )

    symbols = [f"{i:06d}.SZ" for i in range(81)]
    with provider(handle) as p:
        rows = p.get_depth_batch(symbols)
    assert len(rows) == 81
    assert len(calls) == 2
    assert rows[symbols[0]]["bid_volumes"][0] == 11  # hands, never shares
    assert rows[symbols[0]]["timestamp"] == 1789714862345
    assert rows[symbols[0]]["timestamp_provenance"] == "local_receive"


@pytest.mark.parametrize(
    "update",
    [
        {"symbol": "000001.SZ"},
        {"bid_prices": [1, 2]},
        {"ask_volumes": [1, 2, 3, 4, -1]},
        {"bid_volumes": [1, 2, 3, 4, True]},
        {"timestamp": 0},
        {"timestamp_provenance": "exchange"},
    ],
)
def test_bad_depth5_is_rejected(update):
    row = dict(
        symbol="600519.SH",
        bid_prices=[10, 9.99, 9.98, 9.97, 9.96],
        ask_prices=[10.01, 10.02, 10.03, 10.04, 10.05],
        bid_volumes=[1, 2, 3, 4, 5],
        ask_volumes=[1, 2, 3, 4, 5],
        timestamp=1789714862345,
        source_time="150000",
        timestamp_provenance="local_receive",
    )
    row.update(update)
    with provider(lambda _: response([row])) as p, pytest.raises(ValueError):
        p.get_depth_batch(["600519.SH"])


def test_minute_contract_beijing_wallclock_units_range_and_progress():
    progress = []

    def handle(request):
        payload = __import__("json").loads(request.content)
        assert payload["op"] == "minute"
        assert payload["freq"] == "1m"
        return response(
            [
                dict(
                    symbol=payload["symbols"][0],
                    datetime="2026-09-18T09:31:00",
                    open=10,
                    high=10.2,
                    low=9.9,
                    close=10.1,
                    volume=123,
                    amount=124230,
                ),
                dict(
                    symbol=payload["symbols"][0],
                    datetime="2026-09-18T09:32:00",
                    open=10.1,
                    high=10.3,
                    low=10,
                    close=10.2,
                    volume=234,
                    amount=238680,
                ),
            ]
        )

    with provider(handle) as p:
        df = p.get_minute(
            ["600519.SH", "000001.SZ"],
            datetime(2026, 9, 18, 9, 32),
            datetime(2026, 9, 18, 9, 32),
            on_chunk_done=lambda a, b: progress.append((a, b)),
        )
    assert df.height == 2
    assert df.schema["datetime"].time_zone is None
    assert {str(v) for v in df["datetime"]} == {"2026-09-18 09:32:00"}
    assert df["volume"].to_list() == [234.0, 234.0]
    assert df["amount"].to_list() == [238680.0, 238680.0]
    assert progress == [(1, 2), (2, 2)]


def test_minute_accepts_aware_range_and_converts_to_beijing_wallclock():
    def handle(request):
        payload = __import__("json").loads(request.content)
        assert payload["start"] == "2026-09-18T09:31:00"
        assert payload["end"] == "2026-09-18T15:00:00"
        return response([])

    with provider(handle) as p:
        df = p.get_minute(
            ["600519.SH"],
            datetime(2026, 9, 18, 1, 31, tzinfo=UTC),
            datetime(2026, 9, 18, 7, 0, tzinfo=UTC),
        )

    assert df.is_empty()


@pytest.mark.parametrize(
    "row",
    [
        dict(
            symbol="600519.SH",
            datetime="2026-09-18T01:31:00",
            open=10,
            high=11,
            low=9,
            close=10,
            volume=1,
            amount=1,
        ),
        dict(
            symbol="600519.SH",
            datetime="2026-09-18T09:31:00+08:00",
            open=10,
            high=11,
            low=9,
            close=10,
            volume=1,
            amount=1,
        ),
        dict(
            symbol="600519.SH",
            datetime="bad",
            open=10,
            high=11,
            low=9,
            close=10,
            volume=1,
            amount=1,
        ),
        dict(
            symbol="600519.SH",
            datetime="2026-09-18T09:31:00",
            open=10,
            high=9,
            low=8,
            close=10,
            volume=1,
            amount=1,
        ),
        dict(
            symbol="000001.SZ",
            datetime="2026-09-18T09:31:00",
            open=10,
            high=11,
            low=9,
            close=10,
            volume=1,
            amount=1,
        ),
    ],
)
def test_bad_minute_is_rejected(row):
    with provider(lambda _: response([row])) as p, pytest.raises(ValueError):
        p.get_minute(["600519.SH"], None, None)


def test_minute_empty_and_unsupported_frequency():
    with provider(lambda _: response([])) as p:
        assert p.get_minute([], None, None).is_empty()
        with pytest.raises(ValueError):
            p.get_minute(["600519.SH"], None, None, freq="5m")


def test_minute_preview_is_bounded():
    with provider(lambda _: response([])) as p:
        result = p.test_dataset("minute", ["600519.SH"])
    assert result == {
        "provider": "tdx",
        "dataset": "minute",
        "rows": 0,
        "columns": [],
        "preview": [],
    }


def test_availability_health_version_and_units(monkeypatch):
    monkeypatch.setattr(
        "app.plugins.tdx.provider.httpx.get",
        lambda *a, **kw: httpx.Response(
            200,
            json=dict(
                version=1,
                ready=True,
                units=dict(price="yuan", volume="hands", amount="yuan", depth_volume="hands"),
                features=["adj_factor", "daily", "depth5", "minute", "realtime"],
                adj_factor_kind="single_event_ratio",
                depth_timestamp="local_receive",
            ),
        ),
    )
    assert availability()[0]
    monkeypatch.setattr(
        "app.plugins.tdx.provider.httpx.get",
        lambda *a, **kw: httpx.Response(
            200,
            json=dict(
                version=1,
                ready=True,
                units=dict(price="yuan", volume="hands", amount="yuan", depth_volume="hands"),
                features=["daily", "realtime"],
                adj_factor_kind="single_event_ratio",
                depth_timestamp="local_receive",
            ),
        ),
    )
    assert not availability()[0]
    monkeypatch.setattr(
        "app.plugins.tdx.provider.httpx.get",
        lambda *a, **kw: httpx.Response(
            200,
            json=dict(
                version=1,
                ready=True,
                units=dict(price="yuan", volume="hands", amount="yuan", depth_volume="hands"),
                features=1,
                adj_factor_kind="single_event_ratio",
                depth_timestamp="local_receive",
            ),
        ),
    )
    assert not availability()[0]
    monkeypatch.setattr(
        "app.plugins.tdx.provider.httpx.get",
        lambda *a, **kw: httpx.Response(
            200,
            json=dict(version=2, ready=True),
        ),
    )
    assert not availability()[0]


def test_loader_registration_and_manifest(monkeypatch):
    from pathlib import Path

    from app.data_providers.custom import loader

    manifest = yaml.safe_load(
        (Path(__file__).parents[1] / "app/plugins/tdx/plugin.yaml").read_text("utf-8")
    )
    monkeypatch.setattr(loader, "_PROVIDERS", {})
    monkeypatch.setattr(loader, "_PLUGIN_STATUS", {})
    monkeypatch.setattr(loader, "_call_check", lambda _: (True, "ok"))
    loader._register_one_plugin(manifest)
    assert loader.provider_has_dataset("tdx", "daily")
    assert loader.provider_has_dataset("tdx", "minute")
    assert loader.provider_has_dataset("tdx", "adj_factor")
    assert loader.provider_has_dataset("tdx", "depth5")
    loader._PROVIDERS["tdx"].close()


@pytest.mark.parametrize("value", [-1, True, float("nan"), float("inf"), None])
def test_invalid_numeric_values_are_rejected(value):
    rows = [
        dict(
            symbol="600519.SH",
            date="2026-09-18",
            open=10,
            high=11,
            low=9,
            close=10,
            volume=value,
            amount=1,
        )
    ]
    with provider(lambda _: response(rows)) as p, pytest.raises(ValueError):
        p.get_daily(["600519.SH"], None, None)


def test_streaming_error_propagates_after_first_chunk():
    calls = 0

    def handle(request):
        nonlocal calls
        calls += 1
        if calls > 1:
            return httpx.Response(503, json={"error": "offline"})
        return response(
            [
                dict(
                    symbol="600519.SH",
                    date="2026-09-18",
                    open=10,
                    high=11,
                    low=9,
                    close=10,
                    volume=1,
                    amount=1,
                )
            ]
        )

    with provider(handle) as p:
        batches = p.iter_daily(["600519.SH"] * 6, None, None)
        assert next(batches).height == 1
        with pytest.raises(httpx.HTTPStatusError):
            next(batches)


def test_incomplete_quotes_fail_closed():
    with provider(lambda _: response([])) as p:
        assert p.get_realtime_indices(["000001.SH"]) is None
        with pytest.raises(ValueError):
            p._quotes(["600519.SH"])


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com:3020",
        "https://127.0.0.1:3020",
        "http://user:pass@127.0.0.1:3020",
        "http://127.0.0.1:3020/query",
    ],
)
def test_remote_or_non_base_url_is_not_allowed(monkeypatch, url):
    monkeypatch.setenv("TDX_BRIDGE_URL", url)
    assert not availability()[0]


def test_offline_availability(monkeypatch):
    def offline(*args, **kwargs):
        assert kwargs["trust_env"] is False
        raise httpx.ConnectError("offline")

    monkeypatch.setattr("app.plugins.tdx.provider.httpx.get", offline)
    assert not availability()[0]
