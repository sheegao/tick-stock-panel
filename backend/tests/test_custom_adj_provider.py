"""Single-symbol adjustment-factor routing through the selected provider."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

import polars as pl

from app.services import kline_sync


def test_single_adj_factor_uses_selected_custom_provider(monkeypatch):
    expected = pl.DataFrame(
        {
            "symbol": ["600519.SH"],
            "trade_date": [date(2026, 6, 26)],
            "ex_factor": [1.0236639416255657],
        }
    )
    provider = MagicMock()
    provider.get_adj_factors.return_value = expected
    monkeypatch.setattr(kline_sync.preferences, "get_adj_factor_provider", lambda: "tdx")
    monkeypatch.setattr(
        "app.data_providers.custom.provider_has_dataset",
        lambda name, dataset: name == "tdx" and dataset == "adj_factor",
    )
    monkeypatch.setattr("app.data_providers.custom.get_provider", lambda name: provider)

    result = kline_sync.fetch_adj_factor_single("600519.SH")

    assert result.to_dicts() == expected.to_dicts()
    provider.get_adj_factors.assert_called_once_with(
        ["600519.SH"],
        start_time=None,
        end_time=None,
        asset_type="stock",
    )


def test_single_adj_factor_custom_failure_does_not_cross_source_fallback(monkeypatch):
    provider = MagicMock()
    provider.get_adj_factors.side_effect = RuntimeError("tdx unavailable")
    monkeypatch.setattr(kline_sync.preferences, "get_adj_factor_provider", lambda: "tdx")
    monkeypatch.setattr("app.data_providers.custom.provider_has_dataset", lambda *_: True)
    monkeypatch.setattr("app.data_providers.custom.get_provider", lambda name: provider)
    tickflow = MagicMock()
    monkeypatch.setattr(kline_sync, "get_client", tickflow)

    assert kline_sync.fetch_adj_factor_single("600519.SH").is_empty()
    tickflow.assert_not_called()
