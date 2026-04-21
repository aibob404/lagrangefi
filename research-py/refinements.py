"""Refinements targeting whipsaw reduction + VIX term-structure filter."""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import Metrics, TRADING_DAYS, load_close, metrics
from final import build_long_panel, run_strategy


def add_vix_term(df: pd.DataFrame) -> pd.DataFrame:
    """Attach VIX3M/VIX ratio. >1 = contango (calm). <1 = backwardation (stress)."""
    vix3m = load_close("VIX3M", "Close").reindex(df.index).ffill()
    df = df.copy()
    df["vix3m"] = vix3m
    df["term_ratio"] = vix3m / df["vix"]
    return df


def pos_buffered_smart(df, lev=2.0, exit_sma=200, entry_sma=100, exit_buf=0.0, hold_days=3):
    """Smart entry/exit with:
       - exit only when price < SMA*(1-exit_buf) for `hold_days` consecutive closes
       - entry when price > SMA(entry_sma)
    """
    sma_exit = df["spy_adj"].rolling(exit_sma, min_periods=exit_sma).mean()
    sma_entry = df["spy_adj"].rolling(entry_sma, min_periods=entry_sma).mean()
    price = df["spy_adj"]

    exit_trigger = price < (sma_exit * (1 - exit_buf))
    if hold_days > 1:
        exit_confirmed = exit_trigger.rolling(hold_days).sum() >= hold_days
    else:
        exit_confirmed = exit_trigger

    pos = np.zeros(len(df), dtype=float)
    state = 0
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma_entry.iloc[i]:
            state = 1
        elif state == 1 and exit_confirmed.iloc[i]:
            state = 0
        pos[i] = lev if state == 1 else 0.0
    return pd.Series(pos, index=df.index)


def pos_buffered_smart_term(df, lev=2.0, exit_sma=200, entry_sma=100,
                             exit_buf=0.0, hold_days=3, term_gate=0.85):
    """Buffered smart + VIX term-structure gate: exit immediately if term_ratio < term_gate
    (backwardation = real stress)."""
    sma_exit = df["spy_adj"].rolling(exit_sma, min_periods=exit_sma).mean()
    sma_entry = df["spy_adj"].rolling(entry_sma, min_periods=entry_sma).mean()
    price = df["spy_adj"]
    term = df["term_ratio"]

    exit_trigger = price < (sma_exit * (1 - exit_buf))
    if hold_days > 1:
        exit_sma_sig = exit_trigger.rolling(hold_days).sum() >= hold_days
    else:
        exit_sma_sig = exit_trigger
    # immediate exit if VIX term structure inverts
    term_exit = term < term_gate

    pos = np.zeros(len(df), dtype=float)
    state = 0
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0:
            # re-enter when both price > entry-SMA AND term structure normal (or missing)
            if price.iloc[i] > sma_entry.iloc[i] and (np.isnan(term.iloc[i]) or term.iloc[i] >= term_gate):
                state = 1
        elif state == 1:
            if exit_sma_sig.iloc[i] or (not np.isnan(term.iloc[i]) and term_exit.iloc[i]):
                state = 0
        pos[i] = lev if state == 1 else 0.0
    return pd.Series(pos, index=df.index)


def pos_dual_sma_confirm(df, lev=2.0):
    """Hold when price > SMA200 AND SMA50 > SMA200 (golden-cross state).
    Re-enter when price > SMA200 AND SMA50 > SMA200 together (stricter than SMA alone)."""
    price = df["spy_adj"]
    sma50 = price.rolling(50, min_periods=50).mean()
    sma200 = price.rolling(200, min_periods=200).mean()
    cond = (price > sma200) & (sma50 > sma200)
    return cond.astype(float) * lev


def evaluate(df, name, pos, start="1994-01-01"):
    eq, m = run_strategy(df, pos, start=start)
    print(m.pretty(name))
    return eq, m


def period_eval(df, pos, lo, hi):
    pos_s = pos.shift(1).fillna(0)
    cash_r = df["cash_ret"]
    r = (pos_s * df["spy_ret"] - (pos_s-1).clip(lower=0)*cash_r - (pos_s>0)*0.009/TRADING_DAYS
         + (1-pos_s).clip(lower=0)*cash_r)
    r = r - pos_s.diff().abs().fillna(0) * 2.0 / 10000.0
    r = r.loc[(r.index >= lo) & (r.index <= hi)]
    eq = (1 + r.fillna(0)).cumprod()
    return metrics(eq)


def main():
    df = build_long_panel()
    df = add_vix_term(df)
    start = "1994-01-01"
    print(f"\nLong history: {start} → {df.index.max().date()}")
    print("=" * 130)

    # Baselines
    bh_eq = (1 + df["spy_ret"].loc[start:]).cumprod()
    m = metrics(bh_eq)
    print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                  m.vol, 1.0, 0, m.years).pretty("SPY buy-and-hold"))
    print("-" * 130)

    # Existing winner for reference
    from final import pos_smart_entry_exit
    evaluate(df, "Smart 2.0x exit200/entry100 (baseline)", pos_smart_entry_exit(df, 2.0, 200, 100))
    print()

    print("Buffered exit (exit only when price < SMA*(1-buf) for N days):")
    for lev in [2.0, 3.0]:
        for buf in [0.0, 0.02, 0.03, 0.05]:
            for hd in [1, 3, 5]:
                evaluate(df, f"{lev}x smart buf={buf*100:.0f}% hold={hd}d",
                         pos_buffered_smart(df, lev, 200, 100, buf, hd))
    print()

    print("VIX term-structure gate (term_ratio < thr = backwardation = exit):")
    # VIX3M only available from 2006 — evaluate 2006+
    for lev in [2.0, 3.0]:
        for tg in [0.85, 0.90, 0.95, 1.00]:
            pos = pos_buffered_smart_term(df, lev, 200, 100, exit_buf=0.02, hold_days=3, term_gate=tg)
            evaluate(df, f"{lev}x smart term<{tg}", pos, start="2007-01-01")
    print()

    print("Dual SMA confirmation (price > SMA200 AND SMA50 > SMA200):")
    for lev in [2.0, 3.0]:
        evaluate(df, f"{lev}x dual-SMA confirm", pos_dual_sma_confirm(df, lev))
    print()

    print("=" * 130)
    print("Stress tests for top candidates:")
    print("=" * 130)
    cands = [
        ("2x smart 200/100 base",    pos_smart_entry_exit(df, 2.0, 200, 100)),
        ("2x buf=3% hold=3 200/100", pos_buffered_smart(df, 2.0, 200, 100, 0.03, 3)),
        ("2x buf=5% hold=5 200/100", pos_buffered_smart(df, 2.0, 200, 100, 0.05, 5)),
        ("2x dual-SMA confirm",      pos_dual_sma_confirm(df, 2.0)),
    ]
    periods = [
        ("2000-03-01", "2002-10-31", "dot-com"),
        ("2007-10-01", "2009-03-31", "GFC"),
        ("2020-02-15", "2020-05-15", "COVID"),
        ("2022-01-01", "2022-12-31", "2022 bear"),
        ("2018-10-01", "2018-12-31", "Q4-2018"),
        ("2011-07-01", "2011-12-31", "2011"),
    ]
    # header
    header = f"{'':40s}" + "".join(f" {p[2]:>12s}" for p in periods)
    print(header)
    for name, pos in cands:
        line = f"{name:40s}"
        for lo, hi, _ in periods:
            mm = period_eval(df, pos, lo, hi)
            line += f"  {mm.total_return*100:10.1f}%"
        print(line)
    print()
    print("SPY buy-and-hold reference:")
    line = f"{'SPY buy-and-hold':40s}"
    for lo, hi, _ in periods:
        r = df["spy_ret"].loc[(df.index >= lo) & (df.index <= hi)]
        eq = (1 + r).cumprod()
        mm = metrics(eq)
        line += f"  {mm.total_return*100:10.1f}%"
    print(line)

    print()
    print("=" * 130)
    print("WALK-FORWARD on refined strategies:")
    print("=" * 130)
    for lo, hi, lbl in [
        ("1994-01-01", "2003-12-31", "1994-2003"),
        ("2004-01-01", "2013-12-31", "2004-2013"),
        ("2014-01-01", "2026-04-20", "2014-2026"),
    ]:
        print(f"\n{lbl}")
        bh_r = df["spy_ret"].loc[(df.index >= lo) & (df.index <= hi)]
        bh_eq = (1 + bh_r).cumprod()
        mm = metrics(bh_eq)
        print(Metrics(mm.cagr, mm.total_return, mm.sharpe, mm.sortino, mm.max_dd, mm.calmar,
                      mm.vol, 1.0, 0, mm.years).pretty("SPY hold"))
        for name, pos in cands:
            mm = period_eval(df, pos, lo, hi)
            print(Metrics(mm.cagr, mm.total_return, mm.sharpe, mm.sortino, mm.max_dd, mm.calmar,
                          mm.vol, 1.0, 0, mm.years).pretty(name))


if __name__ == "__main__":
    main()
