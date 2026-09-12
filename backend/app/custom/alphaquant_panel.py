"""TSP extension API v1. Fixed read-only proxy to the local AlphaQuant panel.

Native pages share TSP's QueryClient using namespaced execution query keys.
Legacy workbench URLs remain available for compatibility. No broker is imported.
"""

from __future__ import annotations

import os
import re
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse

EXTENSION_ID = "alphaquant.workbench"
EXTENSION_API_VERSION = 1
router = APIRouter(prefix="/api/alphaquant", tags=["AlphaQuant read-only"])


def upstream_path(path: str) -> str:
    if path in {"workbench", "workbench/"}:
        return "/"
    if re.fullmatch(
        r"workbench/assets/[A-Za-z0-9_.-]+\.(?:js|css|svg|png|woff2)", path
    ):
        return "/" + path.removeprefix("workbench/")
    if path in {"health", "runs"} or re.fullmatch(
        r"runs/[a-f0-9]{20}(?:/(?:status|candidates|positions|orders|decisions|timeline|risk_events|quotes|events|review\.md))?",
        path,
    ):
        return "/api/alphaquant/" + path
    if re.fullmatch(
        r"runs/[a-f0-9]{20}/backtest(?:/(?:trades|orders|decisions|positions|candidates|signals|markers|report\.json|trades\.json))?",
        path,
    ):
        return "/api/alphaquant/" + path
    raise HTTPException(404, "Unknown AlphaQuant route")


@router.get("/{path:path}")
async def proxy(path: str, request: Request):
    target_path = upstream_path(path)
    base = os.environ.get("ALPHAQUANT_PANEL_URL", "http://127.0.0.1:8766").rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise HTTPException(503, "ALPHAQUANT_PANEL_URL must be a local HTTP origin")
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(10, read=None, connect=3), trust_env=False
    )
    headers = {
        k: request.headers[k]
        for k in ("last-event-id", "accept")
        if k in request.headers
    }
    try:
        upstream = await client.send(
            client.build_request(
                "GET",
                base + target_path,
                params={
                    k: v
                    for k, v in request.query_params.items()
                    if k in {"cursor", "offset", "limit", "day", "symbol"}
                },
                headers=headers,
            ),
            stream=True,
        )
    except httpx.HTTPError:
        await client.aclose()
        if target_path == "/":
            return HTMLResponse(
                '<html lang="zh-CN"><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>AlphaQuant 工作台尚未启动</h2><p>请在 AlphaQuant 目录启动 python -m alphaquantv2.panel 并刷新此页。</p></body></html>',
                status_code=503,
            )
        raise HTTPException(503, "AlphaQuant panel is unavailable") from None

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                if await request.is_disconnected():
                    break
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    forwarded = {
        k: upstream.headers[k]
        for k in ("content-type", "content-disposition")
        if k in upstream.headers
    }
    return StreamingResponse(
        body(),
        status_code=upstream.status_code,
        headers={
            **forwarded,
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
        },
    )


def setup(registrar) -> None:
    registrar.include_router(router)
