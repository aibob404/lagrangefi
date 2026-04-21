"""Fetch spot crypto prices from OKX public API (no geo block, no auth).

OKX history-candles: up to 100 candles per call, pagination via `after` param (timestamp).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd
import requests

CACHE = Path(__file__).parent / "data"
CACHE.mkdir(exist_ok=True)

OKX_HIST = "https://www.okx.com/api/v5/market/history-candles"

# Map our coin tickers to OKX spot instruments
SPOT_MAP = {
    "BTC": "BTC-USDT",
    "ETH": "ETH-USDT",
    "SOL": "SOL-USDT",
    "AVAX": "AVAX-USDT",
    "LINK": "LINK-USDT",
    "ARB": "ARB-USDT",
    "OP": "OP-USDT",
    "BNB": "BNB-USDT",
    "DOGE": "DOGE-USDT",
}

START_MS = 1704067200000  # 2024-01-01
END_MS = int(time.time() * 1000)


def fetch_okx(inst_id: str, start_ms: int = START_MS, end_ms: int = END_MS,
              bar: str = "1D") -> pd.DataFrame:
    """Fetch daily candles from OKX. Iterates backwards from `after`."""
    rows = []
    after = end_ms
    while True:
        params = {"instId": inst_id, "bar": bar, "limit": 100, "after": after}
        r = requests.get(OKX_HIST, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "0":
            print(f"  ERR: {data}")
            break
        chunk = data.get("data", [])
        if not chunk:
            break
        rows.extend(chunk)
        oldest = int(chunk[-1][0])
        if oldest <= start_ms:
            break
        after = oldest
        time.sleep(0.2)

    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "vol", "vol_ccy", "vol_ccy_quote", "confirm"])
    df["time"] = pd.to_datetime(df["ts"].astype(int), unit="ms", utc=True)
    df = df.set_index("time").sort_index()
    df[["open", "high", "low", "close"]] = df[["open", "high", "low", "close"]].astype(float)
    df = df[~df.index.duplicated(keep="last")]
    df = df.loc[df.index >= pd.Timestamp(START_MS, unit="ms", tz="UTC")]
    return df[["open", "high", "low", "close", "vol"]]


def main():
    for coin, inst in SPOT_MAP.items():
        path = CACHE / f"spot_{coin}_1d.csv"
        if path.exists():
            print(f"{coin}: cached")
            continue
        print(f"{coin} ({inst})...")
        df = fetch_okx(inst)
        if df is None:
            print(f"  failed")
            continue
        df.to_csv(path)
        print(f"  {len(df)} rows  {df.index.min().date()} → {df.index.max().date()}")


if __name__ == "__main__":
    main()
