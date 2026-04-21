"""Fetch Hyperliquid historical data: daily + 1h candles, funding rates.

API reference: https://hyperliquid.gitbook.io/hyperliquid-docs/
Public endpoint: https://api.hyperliquid.xyz/info (POST)
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pandas as pd
import requests

CACHE = Path(__file__).parent / "data"
CACHE.mkdir(exist_ok=True)

API = "https://api.hyperliquid.xyz/info"
COINS = ["BTC", "ETH", "SOL", "HYPE", "AVAX", "LINK", "ARB", "OP", "BNB", "DOGE"]

# HL launched ~2023-06 for perps, HYPE token 2024-11. Use 2024-01-01 as safe start.
START_MS = 1704067200000  # 2024-01-01 UTC
END_MS = int(time.time() * 1000)

# HL /info candles endpoint returns max 5000 bars per call. Hourly over 2 years = ~17520.
# So we chunk: ~5000 hourly = ~208 days per request. Use 180-day windows.
CHUNK_MS = 180 * 24 * 3600 * 1000


def _post(payload: dict, retries: int = 5, timeout: int = 30):
    for attempt in range(retries):
        try:
            r = requests.post(API, json=payload, timeout=timeout)
            if r.status_code == 429:
                wait = 5 + 5 * attempt
                print(f"    429; sleeping {wait}s...")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except requests.exceptions.HTTPError:
            if attempt == retries - 1:
                raise
            time.sleep(3 + 2 ** attempt)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    return None


def fetch_candles(coin: str, interval: str = "1d", start_ms: int = START_MS, end_ms: int = END_MS):
    """Fetch OHLCV candles for a coin."""
    all_rows = []
    cur = start_ms
    while cur < end_ms:
        nxt = min(cur + CHUNK_MS, end_ms)
        payload = {"type": "candleSnapshot", "req": {
            "coin": coin, "interval": interval, "startTime": cur, "endTime": nxt
        }}
        data = _post(payload)
        if not data:
            break
        all_rows.extend(data)
        cur = nxt
        time.sleep(1.2)  # gentle rate limit
    if not all_rows:
        return None
    df = pd.DataFrame(all_rows)
    df["time"] = pd.to_datetime(df["t"], unit="ms", utc=True)
    df = df.rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "n": "trades"})
    df[["open", "high", "low", "close", "volume"]] = df[["open", "high", "low", "close", "volume"]].astype(float)
    df = df.set_index("time").sort_index()
    df = df[~df.index.duplicated(keep="last")]
    return df[["open", "high", "low", "close", "volume", "trades"]]


def fetch_funding(coin: str, start_ms: int = START_MS, end_ms: int = END_MS):
    """Fetch funding rate history. HL pays funding hourly."""
    all_rows = []
    cur = start_ms
    CHUNK = 30 * 24 * 3600 * 1000  # 30 days
    while cur < end_ms:
        nxt = min(cur + CHUNK, end_ms)
        data = _post({"type": "fundingHistory", "coin": coin, "startTime": cur, "endTime": nxt})
        if not data:
            break
        all_rows.extend(data)
        cur = nxt
        time.sleep(1.2)
    if not all_rows:
        return None
    df = pd.DataFrame(all_rows)
    df["time"] = pd.to_datetime(df["time"], unit="ms", utc=True)
    df["fundingRate"] = df["fundingRate"].astype(float)
    df["premium"] = df["premium"].astype(float)
    df = df.set_index("time").sort_index()
    df = df[~df.index.duplicated(keep="last")]
    return df


def fetch_meta():
    data = _post({"type": "meta"})
    return data


def main():
    print("Fetching HL meta...")
    meta = fetch_meta()
    coins_avail = [u["name"] for u in meta["universe"] if not u.get("isDelisted")]
    print(f"  {len(coins_avail)} coins listed")
    print(f"  Our targets: {[c for c in COINS if c in coins_avail]}")

    for coin in COINS:
        if coin not in coins_avail:
            print(f"\n[skip] {coin}: not on HL")
            continue
        # Candles (1d)
        path_c = CACHE / f"hl_{coin}_1d.csv"
        if not path_c.exists():
            print(f"\n[{coin}] 1d candles...")
            df = fetch_candles(coin, "1d")
            if df is not None:
                df.to_csv(path_c)
                print(f"  {len(df)} rows  {df.index.min().date()} → {df.index.max().date()}")
        # (skip 1h candles — not needed for daily strategies, they rate-limit heavily)
        # Funding
        path_f = CACHE / f"hl_{coin}_funding.csv"
        if not path_f.exists():
            print(f"[{coin}] funding...")
            df = fetch_funding(coin)
            if df is not None:
                df.to_csv(path_f)
                print(f"  {len(df)} funding entries  avg rate {df['fundingRate'].mean()*100:.4f}%/hr")


if __name__ == "__main__":
    main()
