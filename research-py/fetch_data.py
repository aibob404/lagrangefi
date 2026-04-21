"""Fetch daily bars for SPY + macro factors, cache to parquet."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import yfinance as yf

CACHE = Path(__file__).parent / "data"
CACHE.mkdir(exist_ok=True)

TICKERS = {
    "SPY":   "SPY",      # S&P 500 ETF
    "QQQ":   "QQQ",      # Nasdaq-100 ETF
    "TLT":   "TLT",      # long treasuries (for risk-off)
    "IEF":   "IEF",      # 7-10y treasuries
    "SHY":   "SHY",      # 1-3y treasuries (cash proxy)
    "BIL":   "BIL",      # 1-3m t-bill ETF (cash proxy)
    "GLD":   "GLD",      # gold (risk-off)
    "VIX":   "^VIX",     # volatility index
    "VIX3M": "^VIX3M",   # 3-month vol
    "VVIX":  "^VVIX",    # vol-of-vol
    "IRX":   "^IRX",     # 13-week t-bill yield
    "TNX":   "^TNX",     # 10y yield
    "FVX":   "^FVX",     # 5y yield
    "TYX":   "^TYX",     # 30y yield
    "HYG":   "HYG",      # high-yield corp
    "LQD":   "LQD",      # investment-grade corp
    "DXY":   "DX-Y.NYB", # dollar index
}

START = "1993-01-01"


def fetch_one(name: str, symbol: str) -> pd.DataFrame | None:
    path = CACHE / f"{name}.csv"
    try:
        df = yf.download(symbol, start=START, progress=False, auto_adjust=False, threads=False)
        if df is None or df.empty:
            print(f"  [warn] {name} ({symbol}): empty")
            return None
        # yfinance returns a multiindex — flatten
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df.to_csv(path)
        print(f"  {name:6s} ({symbol:12s}) {len(df):5d} rows  {df.index.min().date()} → {df.index.max().date()}")
        return df
    except Exception as e:
        print(f"  [err ] {name} ({symbol}): {e}")
        return None


def main() -> int:
    print(f"Fetching {len(TICKERS)} series from Yahoo Finance → {CACHE}")
    fetched = 0
    for name, sym in TICKERS.items():
        if fetch_one(name, sym) is not None:
            fetched += 1
    print(f"\n{fetched}/{len(TICKERS)} series cached.")
    return 0 if fetched == len(TICKERS) else 1


if __name__ == "__main__":
    sys.exit(main())
