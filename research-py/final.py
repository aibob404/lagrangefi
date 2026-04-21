"""Final validation on long history (1994-2026, includes dot-com) + refinements."""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import Metrics, TRADING_DAYS, load, load_close, metrics


def build_long_panel() -> pd.DataFrame:
    """Minimal panel for strategies that need only SPY + VIX + IRX."""
    spy = load("SPY")[["High", "Low", "Close", "Adj Close"]].rename(
        columns={"High": "spy_high", "Low": "spy_low", "Close": "spy_close", "Adj Close": "spy_adj"}
    )
    vix = load_close("VIX", "Close").rename("vix")
    irx = load_close("IRX", "Close").rename("y3m")

    df = spy.join([vix, irx], how="outer").sort_index()
    df = df.loc[spy.index]
    df["vix"] = df["vix"].ffill()
    df["y3m"] = df["y3m"].ffill()
    df["spy_ret"] = df["spy_adj"].pct_change().fillna(0.0)
    y = df["y3m"].ffill() / 100.0
    df["cash_ret"] = (1 + y) ** (1 / TRADING_DAYS) - 1

    # TLT/IEF when available, else zero (we won't use hedge before 2002)
    tlt = load_close("TLT", "Adj Close").reindex(df.index).ffill()
    df["tlt_ret"] = tlt.pct_change().fillna(0.0)
    ief = load_close("IEF", "Adj Close").reindex(df.index).ffill()
    df["ief_ret"] = ief.pct_change().fillna(0.0)
    return df


def run_strategy(df: pd.DataFrame, pos: pd.Series, hedge_pos: pd.Series | None = None,
                 hedge_col: str = "tlt_ret", lev_expense: float = 0.009,
                 cost_bps: float = 2.0, start: str = "1994-01-01") -> tuple[pd.Series, Metrics]:
    """Run a strategy given daily position weights. pos > 1 means leveraged."""
    pos = pos.shift(1).fillna(0.0)
    if hedge_pos is None:
        hedge_pos = pd.Series(0.0, index=df.index)
    hedge_pos = hedge_pos.shift(1).fillna(0.0)

    cash_r = df["cash_ret"]
    lev_borrow = (pos - 1).clip(lower=0)  # fraction borrowed above 1x
    cash_weight = (1 - pos - hedge_pos).clip(lower=0)

    ret = (pos * df["spy_ret"]
           + hedge_pos * df[hedge_col]
           - lev_borrow * cash_r
           - (pos > 0) * lev_expense / TRADING_DAYS
           + cash_weight * cash_r)
    turn = pos.diff().abs().fillna(0) + hedge_pos.diff().abs().fillna(0)
    ret = ret - turn * cost_bps / 10000.0
    ret = ret.loc[ret.index >= start]
    equity = (1 + ret.fillna(0)).cumprod()

    m = metrics(equity)
    tim = float(((pos + hedge_pos.abs()) > 0).loc[equity.index].mean())
    sw = int((pos.diff().abs() + hedge_pos.diff().abs()).gt(0.001).loc[equity.index].sum())
    return equity, Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                           m.vol, tim, sw, m.years)


def pos_buyhold(df):
    return pd.Series(1.0, index=df.index)


def pos_sma_leveraged(df, n: int = 200, lev: float = 2.0) -> pd.Series:
    sma = df["spy_adj"].rolling(n, min_periods=n).mean()
    return ((df["spy_adj"] > sma).astype(float) * lev)


def pos_sma_lev_vix(df, n: int = 200, lev: float = 2.0, vix_cap: float = 40.0) -> pd.Series:
    """Filter: require price > SMA AND VIX below cap."""
    sma = df["spy_adj"].rolling(n, min_periods=n).mean()
    ok = (df["spy_adj"] > sma) & (df["vix"] < vix_cap)
    return ok.astype(float) * lev


def pos_smart_entry_exit(df, lev: float = 2.0, exit_sma: int = 200, entry_sma: int = 100) -> pd.Series:
    """State machine: exit when price < SMA(exit_sma), re-enter only when price > SMA(entry_sma).
    entry_sma < exit_sma makes re-entry faster (reduces whipsaw cost but adds a bit of risk)."""
    sma_exit = df["spy_adj"].rolling(exit_sma, min_periods=exit_sma).mean()
    sma_entry = df["spy_adj"].rolling(entry_sma, min_periods=entry_sma).mean()
    price = df["spy_adj"]

    pos = np.zeros(len(df), dtype=float)
    state = 0  # 0=flat, 1=long
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma_entry.iloc[i]:
            state = 1
        elif state == 1 and price.iloc[i] < sma_exit.iloc[i]:
            state = 0
        pos[i] = lev if state == 1 else 0.0
    return pd.Series(pos, index=df.index)


def pos_regime_leverage(df) -> pd.Series:
    """Dynamic leverage by VIX bucket. Re-uses SMA filter."""
    sma = df["spy_adj"].rolling(200, min_periods=200).mean()
    above = df["spy_adj"] > sma
    vix = df["vix"]

    lev = pd.Series(0.0, index=df.index)
    lev[above & (vix < 18)] = 3.0
    lev[above & (vix >= 18) & (vix < 25)] = 2.0
    lev[above & (vix >= 25) & (vix < 35)] = 1.5
    lev[above & (vix >= 35) & (vix < 45)] = 1.0
    lev[above & (vix >= 45)] = 0.0
    return lev


def pos_smart_entry_regime(df) -> pd.Series:
    """Combine smart entry/exit (price vs 100/200 SMAs) with VIX-regime leverage."""
    sma_exit = df["spy_adj"].rolling(200, min_periods=200).mean()
    sma_entry = df["spy_adj"].rolling(100, min_periods=100).mean()
    price = df["spy_adj"]
    vix = df["vix"]

    state = 0
    pos = np.zeros(len(df), dtype=float)
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma_entry.iloc[i]:
            state = 1
        elif state == 1 and price.iloc[i] < sma_exit.iloc[i]:
            state = 0
        if state == 1:
            v = vix.iloc[i]
            if v < 18:   lev = 3.0
            elif v < 25: lev = 2.0
            elif v < 35: lev = 1.5
            elif v < 45: lev = 1.0
            else:        lev = 0.0
            pos[i] = lev
        else:
            pos[i] = 0.0
    return pd.Series(pos, index=df.index)


def run_and_print(df, name, pos_fn, start="1994-01-01", hedge_pos=None):
    pos = pos_fn(df)
    eq, m = run_strategy(df, pos, hedge_pos=hedge_pos, start=start)
    print(m.pretty(name))
    return eq, m


def sub(df: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    return df.loc[(df.index >= start) & (df.index <= end)]


def period_table(df: pd.DataFrame, start: str, end: str, label: str):
    print(f"\n=== {label}  ({start} → {end}) ===")
    d = sub(df, start, end).copy()
    if len(d) < 50:
        print("  (insufficient data)")
        return
    bh = (1 + d["spy_ret"]).cumprod()
    m = metrics(bh)
    print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                  m.vol, 1.0, 0, m.years).pretty("SPY buy-and-hold"))
    for lev in [2.0, 3.0]:
        pos = pos_sma_leveraged(df, 200, lev)
        _, m = run_strategy(df, pos, start=start)
        # trim the equity to [start, end]
        pos_s = pos.shift(1).fillna(0)
        cash_r = df["cash_ret"]
        r = (pos_s * df["spy_ret"] - (pos_s-1).clip(lower=0)*cash_r - (pos_s>0)*0.009/TRADING_DAYS
             + (1-pos_s).clip(lower=0)*cash_r)
        r = r - pos_s.diff().abs().fillna(0) * 2.0 / 10000.0
        r = r.loc[(r.index >= start) & (r.index <= end)]
        eq = (1 + r.fillna(0)).cumprod()
        mm = metrics(eq)
        print(Metrics(mm.cagr, mm.total_return, mm.sharpe, mm.sortino, mm.max_dd, mm.calmar,
                      mm.vol, 1.0, 0, mm.years).pretty(f"{lev}x + SMA200"))


def main():
    df = build_long_panel()

    print("\n" + "=" * 130)
    print("LONG HISTORY: 1994-2026 (33 years, includes dot-com)")
    print("=" * 130)
    start = "1994-01-01"

    run_and_print(df, "SPY buy-and-hold", pos_buyhold, start)
    print("-" * 130)

    for n in [100, 150, 200]:
        for lev in [1.0, 2.0, 3.0]:
            run_and_print(df, f"SMA{n} lev={lev}x", lambda d, n=n, l=lev: pos_sma_leveraged(d, n, l), start)
    print("-" * 130)
    print("SMA + VIX filter:")
    for vc in [30, 35, 40]:
        for lev in [2.0, 3.0]:
            run_and_print(df, f"{lev}x SMA200 VIX<{vc}",
                          lambda d, l=lev, v=vc: pos_sma_lev_vix(d, 200, l, float(v)), start)
    print("-" * 130)
    print("Smart entry/exit (exit<SMA200, re-enter>SMA100):")
    for lev in [1.5, 2.0, 3.0]:
        run_and_print(df, f"{lev}x smart 200/100",
                      lambda d, l=lev: pos_smart_entry_exit(d, l, 200, 100), start)
    for exit_n, entry_n in [(200, 50), (200, 150), (150, 100), (150, 50)]:
        run_and_print(df, f"2.0x smart exit{exit_n}/entry{entry_n}",
                      lambda d, e=exit_n, en=entry_n: pos_smart_entry_exit(d, 2.0, e, en), start)
    print("-" * 130)
    print("Regime leverage:")
    run_and_print(df, "VIX-regime lev (SMA200 gate)", pos_regime_leverage, start)
    run_and_print(df, "VIX-regime + smart entry",    pos_smart_entry_regime, start)

    print()
    print("=" * 130)
    print("SUB-PERIODS — stress tests including dot-com (2000-2002)")
    print("=" * 130)
    period_table(df, "2000-03-01", "2002-10-31", "Dot-com bust")
    period_table(df, "2007-10-01", "2009-03-31", "GFC")
    period_table(df, "2020-02-15", "2020-05-15", "COVID crash")
    period_table(df, "2022-01-01", "2022-12-31", "2022 bear")
    period_table(df, "2018-10-01", "2018-12-31", "Q4-2018 vol shock")
    period_table(df, "2011-07-01", "2011-12-31", "2011 debt-ceiling")

    print()
    print("=" * 130)
    print("WALK-FORWARD on long history:")
    print("=" * 130)
    for lo, hi, lbl in [
        ("1994-01-01", "2003-12-31", "1994-2003"),
        ("2004-01-01", "2013-12-31", "2004-2013"),
        ("2014-01-01", "2026-04-20", "2014-2026"),
    ]:
        print(f"\n{lbl}")
        # recompute positions over full df, slice results
        for name, pos_fn in [
            ("SPY hold", pos_buyhold),
            ("2x SMA200", lambda d: pos_sma_leveraged(d, 200, 2.0)),
            ("3x SMA200", lambda d: pos_sma_leveraged(d, 200, 3.0)),
            ("Smart 200/100 lev=2", lambda d: pos_smart_entry_exit(d, 2.0, 200, 100)),
            ("VIX-regime smart", pos_smart_entry_regime),
        ]:
            pos = pos_fn(df)
            pos_s = pos.shift(1).fillna(0)
            cash_r = df["cash_ret"]
            r = (pos_s * df["spy_ret"] - (pos_s-1).clip(lower=0)*cash_r - (pos_s>0)*0.009/TRADING_DAYS
                 + (1-pos_s).clip(lower=0)*cash_r)
            r = r - pos_s.diff().abs().fillna(0) * 2.0 / 10000.0
            r = r.loc[(r.index >= lo) & (r.index <= hi)]
            eq = (1 + r.fillna(0)).cumprod()
            mm = metrics(eq)
            tim = float((pos_s > 0).loc[r.index].mean())
            print(Metrics(mm.cagr, mm.total_return, mm.sharpe, mm.sortino, mm.max_dd, mm.calmar,
                          mm.vol, tim, 0, mm.years).pretty(name))


if __name__ == "__main__":
    main()
