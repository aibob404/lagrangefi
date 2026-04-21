"""Validate synthetic 2x SPY vs real SSO ETF.

SSO launched 2006-06-21. Comparing CAGR, drawdown, tracking error.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

from common import TRADING_DAYS, metrics, load_close
from final import build_long_panel
from refinements import pos_buffered_smart


CACHE = Path(__file__).parent / "data"


def fetch_sso_upro():
    for sym in ("SSO", "UPRO"):
        path = CACHE / f"{sym}.csv"
        if path.exists():
            print(f"  {sym}: cached")
            continue
        df = yf.download(sym, start="2005-01-01", progress=False, auto_adjust=False, threads=False)
        if df is None or df.empty:
            print(f"  [warn] {sym}: empty")
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df.to_csv(path)
        print(f"  {sym}: {len(df)} rows  {df.index.min().date()} → {df.index.max().date()}")


def main():
    fetch_sso_upro()

    df = build_long_panel()
    sso = load_close("SSO", "Adj Close").reindex(df.index).dropna()
    upro = load_close("UPRO", "Adj Close").reindex(df.index).dropna()

    sso_start = sso.index.min()
    upro_start = upro.index.min()
    print(f"\nSSO  first bar: {sso_start.date()}")
    print(f"UPRO first bar: {upro_start.date()}")

    # compare synthetic 2x vs SSO since SSO inception
    synth_2x = 2.0 * df["spy_ret"] - 1.0 * df["cash_ret"] - 0.0089 / TRADING_DAYS
    synth_3x = 3.0 * df["spy_ret"] - 2.0 * df["cash_ret"] - 0.0091 / TRADING_DAYS
    sso_ret = sso.pct_change().fillna(0)
    upro_ret = upro.pct_change().fillna(0)

    # align
    start = max(sso_start, df.index.min())
    window = df.index[df.index >= start]
    print(f"\nComparison window: {start.date()} → {df.index.max().date()}")

    syn_eq = (1 + synth_2x.loc[window]).cumprod()
    sso_eq = (1 + sso_ret.loc[window]).cumprod()
    spy_eq = (1 + df["spy_ret"].loc[window]).cumprod()

    print("\n--- Buy-and-hold equivalents (no timing) ---")
    for name, eq in [("SPY hold", spy_eq), ("Synthetic 2x SPY hold", syn_eq), ("SSO hold", sso_eq)]:
        m = metrics(eq)
        print(f"{name:28s}  CAGR={m.cagr*100:6.2f}%  Sharpe={m.sharpe:4.2f}  MaxDD={m.max_dd*100:6.2f}%  TR={m.total_return*100:7.1f}%")

    # tracking error
    te = (synth_2x.loc[window] - sso_ret.loc[window]).std() * np.sqrt(TRADING_DAYS)
    ann_gap = synth_2x.loc[window].mean() * TRADING_DAYS - sso_ret.loc[window].mean() * TRADING_DAYS
    print(f"\nDaily return diff: synthetic 2x vs SSO")
    print(f"  Annualised return gap: {ann_gap*100:+.2f}% (synthetic {('overstates' if ann_gap > 0 else 'understates')} SSO)")
    print(f"  Tracking error (ann): {te*100:.2f}%")

    # Now compare timed strategies
    print("\n--- Timed strategies (smart + 5d confirm) ---")
    pos_2x = pos_buffered_smart(df, 2.0, 200, 100, 0.0, 5)
    # using synthetic 2x
    syn_eq_timed = compute_timed_equity(df, pos_2x, synth_2x, window)
    # using real SSO
    sso_eq_timed = compute_timed_equity(df, pos_2x, sso_ret, window)

    for name, eq in [("Synthetic 2x timed", syn_eq_timed), ("Real SSO timed", sso_eq_timed)]:
        m = metrics(eq)
        print(f"{name:28s}  CAGR={m.cagr*100:6.2f}%  Sharpe={m.sharpe:4.2f}  MaxDD={m.max_dd*100:6.2f}%")

    # UPRO comparison (3x)
    print("\n--- 3x comparison: synthetic vs UPRO ---")
    window3 = df.index[df.index >= upro_start]
    syn3_eq = (1 + synth_3x.loc[window3]).cumprod()
    upro_eq = (1 + upro_ret.loc[window3]).cumprod()
    for name, eq in [("SPY hold", (1 + df["spy_ret"].loc[window3]).cumprod()),
                     ("Synthetic 3x hold", syn3_eq),
                     ("UPRO hold", upro_eq)]:
        m = metrics(eq)
        print(f"{name:28s}  CAGR={m.cagr*100:6.2f}%  Sharpe={m.sharpe:4.2f}  MaxDD={m.max_dd*100:6.2f}%")


def compute_timed_equity(df, pos, lev_ret, window):
    pos_s = pos.shift(1).fillna(0)
    on = (pos_s > 0).astype(float)
    # when on, earn (pos/base_lev) * lev_ret. We assume pos=2 means 1x SSO.
    # actually pos is already the target leverage, so when pos=2 and lev_ret is 2x already, holding 1 unit of SSO = pos_s/2 of SSO.
    sso_weight = on * 1.0  # fully in SSO when signal on
    cash_weight = 1 - sso_weight
    # simple: full portfolio = sso_weight * sso + cash_weight * cash
    r = sso_weight * lev_ret + cash_weight * df["cash_ret"]
    turn = sso_weight.diff().abs().fillna(0)
    r = r - turn * 2.0 / 10000.0
    r = r.loc[window]
    return (1 + r.fillna(0)).cumprod()


if __name__ == "__main__":
    main()
