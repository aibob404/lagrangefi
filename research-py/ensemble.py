"""Final ensemble: smart entry/exit with VIX-adjusted leverage + summary comparison."""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import Metrics, TRADING_DAYS, metrics
from final import build_long_panel, run_strategy
from refinements import add_vix_term, pos_buffered_smart, pos_dual_sma_confirm
from final import pos_smart_entry_exit


def pos_adaptive_leverage(df, base_lev=2.0, exit_sma=200, entry_sma=100, hold_days=5):
    """Adaptive leverage by VIX regime, with smart entry/exit.

    In-market leverage:
        VIX < 18:  3x  (stable bull)
        VIX 18-25: 2x  (normal)
        VIX 25-35: 1x  (elevated vol)
        VIX > 35:  0.5x (risk-off but not panic)
    Entry: price > SMA100
    Exit:  price < SMA200 for `hold_days` consecutive closes
    """
    sma_exit = df["spy_adj"].rolling(exit_sma, min_periods=exit_sma).mean()
    sma_entry = df["spy_adj"].rolling(entry_sma, min_periods=entry_sma).mean()
    price = df["spy_adj"]
    vix = df["vix"]

    below = (price < sma_exit).astype(int)
    exit_confirmed = below.rolling(hold_days).sum() >= hold_days

    pos = np.zeros(len(df), dtype=float)
    state = 0
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma_entry.iloc[i]:
            state = 1
        elif state == 1 and exit_confirmed.iloc[i]:
            state = 0
        if state == 1:
            v = vix.iloc[i]
            if v < 18:   lev = 3.0
            elif v < 25: lev = 2.0
            elif v < 35: lev = 1.0
            else:        lev = 0.5
        else:
            lev = 0.0
        pos[i] = lev
    return pd.Series(pos, index=df.index)


def pos_adaptive_lev_v2(df, exit_sma=200, entry_sma=100, hold_days=5):
    """More aggressive adaptive: cap at 3x, use finer VIX buckets."""
    sma_exit = df["spy_adj"].rolling(exit_sma, min_periods=exit_sma).mean()
    sma_entry = df["spy_adj"].rolling(entry_sma, min_periods=entry_sma).mean()
    price = df["spy_adj"]
    vix = df["vix"]

    below = (price < sma_exit).astype(int)
    exit_confirmed = below.rolling(hold_days).sum() >= hold_days

    pos = np.zeros(len(df), dtype=float)
    state = 0
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma_entry.iloc[i]:
            state = 1
        elif state == 1 and exit_confirmed.iloc[i]:
            state = 0
        if state == 1:
            v = vix.iloc[i]
            if v < 15:   lev = 3.0
            elif v < 20: lev = 2.5
            elif v < 25: lev = 2.0
            elif v < 30: lev = 1.5
            elif v < 40: lev = 1.0
            else:        lev = 0.5
        else:
            lev = 0.0
        pos[i] = lev
    return pd.Series(pos, index=df.index)


def pos_hybrid_dual_smart(df, lev=2.0, hold_days=5):
    """
    Entry: price > SMA200 AND SMA50 > SMA200 (stricter — avoids whipsaw re-entries)
    Exit:  price < SMA200 for `hold_days` days
    """
    price = df["spy_adj"]
    sma50 = price.rolling(50, min_periods=50).mean()
    sma200 = price.rolling(200, min_periods=200).mean()

    below = (price < sma200).astype(int)
    exit_confirmed = below.rolling(hold_days).sum() >= hold_days

    pos = np.zeros(len(df), dtype=float)
    state = 0
    for i in range(len(df)):
        if np.isnan(sma200.iloc[i]) or np.isnan(sma50.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma200.iloc[i] and sma50.iloc[i] > sma200.iloc[i]:
            state = 1
        elif state == 1 and exit_confirmed.iloc[i]:
            state = 0
        pos[i] = lev if state == 1 else 0.0
    return pd.Series(pos, index=df.index)


def eval_all(df, name, pos, start="1994-01-01"):
    eq, m = run_strategy(df, pos, start=start)
    print(m.pretty(name))
    return eq, m


def period_cagr(df, pos, lo, hi):
    pos_s = pos.shift(1).fillna(0)
    cash_r = df["cash_ret"]
    r = (pos_s * df["spy_ret"] - (pos_s-1).clip(lower=0)*cash_r - (pos_s>0)*0.009/TRADING_DAYS
         + (1-pos_s).clip(lower=0)*cash_r)
    r = r - pos_s.diff().abs().fillna(0) * 2.0 / 10000.0
    r = r.loc[(r.index >= lo) & (r.index <= hi)]
    eq = (1 + r.fillna(0)).cumprod()
    return metrics(eq)


def period_cagr_bh(df, lo, hi):
    r = df["spy_ret"].loc[(df.index >= lo) & (df.index <= hi)]
    eq = (1 + r).cumprod()
    return metrics(eq)


def main():
    df = add_vix_term(build_long_panel())
    start = "1994-01-01"
    print(f"\nLong history: {start} → {df.index.max().date()}")
    print("=" * 130)

    bh_eq = (1 + df["spy_ret"].loc[start:]).cumprod()
    m_bh = metrics(bh_eq)
    print(Metrics(m_bh.cagr, m_bh.total_return, m_bh.sharpe, m_bh.sortino, m_bh.max_dd, m_bh.calmar,
                  m_bh.vol, 1.0, 0, m_bh.years).pretty("SPY buy-and-hold"))
    print("-" * 130)

    # Finalists from prior tests
    eval_all(df, "2x smart 200/100 (baseline)",      pos_smart_entry_exit(df, 2.0, 200, 100))
    eval_all(df, "2x smart hold=5d",                 pos_buffered_smart(df, 2.0, 200, 100, 0.0, 5))
    eval_all(df, "2x dual-SMA confirm",              pos_dual_sma_confirm(df, 2.0))
    eval_all(df, "2x hybrid dual+smart exit=5d",     pos_hybrid_dual_smart(df, 2.0, 5))
    print()
    print("Adaptive-leverage (VIX bucketed, smart entry/exit, hold=5d):")
    eval_all(df, "Adaptive (0.5-3x)",                pos_adaptive_leverage(df))
    eval_all(df, "Adaptive-v2 (0.5-3x, finer)",      pos_adaptive_lev_v2(df))
    print()

    print("=" * 130)
    print(f"{'Strategy':40s}  {'full':>10s}  {'94-03':>8s}  {'04-13':>8s}  {'14-26':>8s}  |  {'DOT':>6s} {'GFC':>6s} {'COV':>6s} {'22':>6s} {'Q418':>6s} {'2011':>6s}")
    print("=" * 130)

    strats = [
        ("SPY buy-and-hold",              None),
        ("2x smart 200/100 base",         pos_smart_entry_exit(df, 2.0, 200, 100)),
        ("2x smart hold=5d",              pos_buffered_smart(df, 2.0, 200, 100, 0.0, 5)),
        ("2x dual-SMA confirm",           pos_dual_sma_confirm(df, 2.0)),
        ("2x hybrid dual+exit5d",         pos_hybrid_dual_smart(df, 2.0, 5)),
        ("Adaptive (0.5-3x)",             pos_adaptive_leverage(df)),
        ("Adaptive-v2",                   pos_adaptive_lev_v2(df)),
        ("3x smart hold=5d",              pos_buffered_smart(df, 3.0, 200, 100, 0.0, 5)),
    ]
    periods = [
        ("2000-03-01", "2002-10-31"),
        ("2007-10-01", "2009-03-31"),
        ("2020-02-15", "2020-05-15"),
        ("2022-01-01", "2022-12-31"),
        ("2018-10-01", "2018-12-31"),
        ("2011-07-01", "2011-12-31"),
    ]
    wf_periods = [("1994-01-01", "2003-12-31"), ("2004-01-01", "2013-12-31"), ("2014-01-01", "2026-04-20")]

    for name, pos in strats:
        if pos is None:
            full = m_bh
            wf = [period_cagr_bh(df, lo, hi) for lo, hi in wf_periods]
            stress = [period_cagr_bh(df, lo, hi).total_return * 100 for lo, hi in periods]
        else:
            _, full = run_strategy(df, pos, start=start)
            wf = [period_cagr(df, pos, lo, hi) for lo, hi in wf_periods]
            stress = [period_cagr(df, pos, lo, hi).total_return * 100 for lo, hi in periods]
        line = f"{name:40s}  {full.cagr*100:9.2f}%  {wf[0].cagr*100:7.2f}%  {wf[1].cagr*100:7.2f}%  {wf[2].cagr*100:7.2f}%  |  "
        line += " ".join(f"{s:5.1f}%" for s in stress)
        print(line)


if __name__ == "__main__":
    main()
