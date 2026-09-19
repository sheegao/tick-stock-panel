"""Explicit resumable historical backfill. Run from backend: python -m scripts.collect_st_announcements."""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from app.config import settings
from app.services.st_archive import StArchive
from app.services.st_collection import archive_announcement, get_daily_st_announcements


async def collect(args):
    store = StArchive(settings.data_dir)
    if args.membership:
        payload = json.loads(Path(args.membership).read_text(encoding="utf-8-sig"))
        store.import_intervals(payload["intervals"])
    current = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    if current < date(1990, 1, 1) or end < current or end > datetime.now(ZoneInfo("Asia/Shanghai")).date():
        raise ValueError("日期范围无效")
    failed = 0
    while current <= end:
        try:
            result = await get_daily_st_announcements(current, data_dir=settings.data_dir, refresh=args.refresh, include_all=True)
            print(f"{current} market={result['market_announcement_count']} ST={result['st_announcement_count']} partial={result['partial']} stale={result['stale']}", flush=True)
            if result["partial"] or result["stale"]:
                failed += 1
            if args.pdf:
                for item in result["items"]:
                    if args.pdf == "important" and item["importance"] == "low":
                        continue
                    try:
                        document = await archive_announcement(current, item["id"], settings.data_dir)
                        print(f"  {item['symbol']} {item['id']} {document['status']}", flush=True)
                        if document["status"] != "ready":
                            failed += 1
                    except Exception:
                        failed += 1
                        print(f"  {item['id']} archive_failed", flush=True)
        except Exception:
            failed += 1
            print(f"{current} collection_failed; rerun to resume", flush=True)
        current += timedelta(days=1)
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--pdf", choices=["important", "all"])
    parser.add_argument("--membership", help="核验后的历史证券简称区间 JSON")
    raise SystemExit(asyncio.run(collect(parser.parse_args())))


if __name__ == "__main__":
    main()
