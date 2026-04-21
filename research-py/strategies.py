"""A suite of strategies vs SPY buy-and-hold. Each returns (name, equity, metrics)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from common import Metrics, TRADING_DAYS, metrics, load_close
from macro_engine import build_panel, macro_score


# ---------- core data panel ----------

def data_panel() -> pd.DataFrame:
    panel = build_panel()
    scores = macro_score(panel)
    df = scores.copy()
    df["spy_ret"] = df["spy_adj"].pct_change().fillna(0.0)

    # cash = 13w t-bill yield, daily compounded
    y3m = df["y3m"].ffill() / 100.0
    df["cash_ret"] = (1 + y3m) ** (1 / TRADING_DAYS) - 1

    # bond hedge: TLT total return
    tlt = load_close("TLT", "Adj Close").reindex(df.index).ffill()
    df["tlt_ret"] = tlt.pct_change().fillna(0.0)

    # IEF (more robust than TLT in rising-rate periods)
    ief = load_close("IEF", "Adj Close").reindex(df.index).ffill()
    df["ief_ret"] = ief.pct_change().fillna(0.0)

    # Gold
    gld = load_close("GLD", "Adj Close").reindex(df.index).ffill()
    df["gld_ret"] = gld.pct_change().fillna(0.0)

    # QQQ
    qqq = load_close("QQQ", "Adj Close").reindex(df.index).ffill()
    df["qqq_ret"] = qqq.pct_change().fillna(0.0)

    return df


# ---------- simulation helper ----------

def simulate(df: pd.DataFrame, pos_spy: pd.Series, pos_cash: pd.Series | None = None,
             pos_hedge: pd.Series | None = None, hedge_col: str = "tlt_ret",
             lag: int = 1, cost_bps: float = 1.0,
             start: str | None = None) -> tuple[pd.Series, Metrics, int]:
    """
    pos_spy, pos_cash, pos_hedge: target weights (0..1 typically, but can be 0..leverage for SPY).
    Returns (equity, metrics, num_switches).
    """
    if pos_cash is None:
        pos_cash = 1.0 - pos_spy - (pos_hedge if pos_hedge is not None else 0.0)
    if pos_hedge is None:
        pos_hedge = pd.Series(0.0, index=df.index)

    # lag execution by `lag` days — signal at close of t-lag -> held at t
    p_spy = pos_spy.shift(lag).fillna(0.0)
    p_cash = pos_cash.shift(lag).fillna(0.0)
    p_hedge = pos_hedge.shift(lag).fillna(0.0)

    # portfolio return
    ret = (p_spy * df["spy_ret"] + p_cash * df["cash_ret"] + p_hedge * df[hedge_col])

    # turnover cost
    turn = (p_spy.diff().abs().fillna(0) + p_hedge.diff().abs().fillna(0))  # cash changes implied by these
    costs = turn * cost_bps / 10000.0

    net = ret - costs

    if start:
        net = net.loc[net.index >= start]

    equity = (1 + net.fillna(0)).cumprod()

    # count position changes (any shift in p_spy OR p_hedge)
    pos_df = pd.concat([p_spy, p_hedge], axis=1).diff().abs().sum(axis=1)
    if start:
        pos_df = pos_df.loc[pos_df.index >= start]
    num_switches = int((pos_df > 0.001).sum())

    m = metrics(equity)
    time_in_mkt = float(((p_spy + p_hedge.abs()) > 0).loc[equity.index].mean())
    m = Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                m.vol, time_in_mkt, num_switches, m.years)
    return equity, m, num_switches


# ---------- strategies ----------

def strat_buyhold(df: pd.DataFrame) -> pd.Series:
    return pd.Series(1.0, index=df.index)


def strat_faber_sma(df: pd.DataFrame, n: int = 200) -> pd.Series:
    """Faber 10-month (200d) SMA timing: long when price > SMA, else flat."""
    sma_n = df["spy_adj"].rolling(n, min_periods=n).mean()
    return (df["spy_adj"] > sma_n).astype(float)


def strat_dual_momentum(df: pd.DataFrame, lookback: int = 252) -> pd.Series:
    """Hold SPY if 12m SPY return > 12m cash return, else cash."""
    spy_12m = df["spy_adj"].pct_change(lookback)
    # cash 12m return ≈ compound of daily cash_ret
    cash_12m = (1 + df["cash_ret"]).rolling(lookback).apply(np.prod, raw=True) - 1
    return (spy_12m > cash_12m).astype(float).fillna(0)


def strat_sma_vix(df: pd.DataFrame, n: int = 200, vix_cap: float = 30.0) -> pd.Series:
    """Long SPY only when both above 200-SMA AND VIX below cap."""
    sma_n = df["spy_adj"].rolling(n, min_periods=n).mean()
    return ((df["spy_adj"] > sma_n) & (df["vix"] < vix_cap)).astype(float)


def strat_mbase_simple(df: pd.DataFrame, thr: int = 1) -> pd.Series:
    return (df["mbase"] >= thr).astype(float)


def strat_sma_plus_momentum(df: pd.DataFrame) -> pd.Series:
    """Combined: 200-SMA AND 12m momentum AND VIX < 35."""
    sma200 = df["spy_adj"].rolling(200, min_periods=200).mean()
    mom_12m = df["spy_adj"].pct_change(252)
    cash_12m = (1 + df["cash_ret"]).rolling(252).apply(np.prod, raw=True) - 1
    cond = (df["spy_adj"] > sma200) & (mom_12m > cash_12m) & (df["vix"] < 35.0)
    return cond.astype(float).fillna(0)


def strat_sma_with_leverage(df: pd.DataFrame, n: int = 200, lev: float = 2.0) -> tuple[pd.Series, pd.Series]:
    """
    Simulate daily 2x SPY (like SSO) when above 200-SMA, else cash.
    We create synthetic 2x returns: lev * spy_ret - (lev-1)*cash_rate - 0.001/252 (0.1% annual expense)
    """
    sma_n = df["spy_adj"].rolling(n, min_periods=n).mean()
    above = (df["spy_adj"] > sma_n).astype(float)
    return above, pd.Series(0.0, index=df.index)  # pos_spy only; we'll swap series


def run_leveraged(df: pd.DataFrame, n: int = 200, lev: float = 2.0, vix_cap: float | None = None,
                  start: str | None = None, cost_bps: float = 2.0) -> tuple[pd.Series, Metrics]:
    """Simulate leveraged SPY with SMA filter."""
    sma_n = df["spy_adj"].rolling(n, min_periods=n).mean()
    cond = df["spy_adj"] > sma_n
    if vix_cap is not None:
        cond = cond & (df["vix"] < vix_cap)
    pos = cond.astype(float).shift(1).fillna(0.0)

    # synthetic leveraged daily return: lev * spy_ret - (lev-1) * cash_ret - expense/TRADING_DAYS
    expense_pa = 0.0091 if lev >= 3 else 0.0089  # SSO/UPRO-like
    lev_ret = lev * df["spy_ret"] - (lev - 1) * df["cash_ret"] - expense_pa / TRADING_DAYS

    ret = pos * lev_ret + (1 - pos) * df["cash_ret"]
    turn = pos.diff().abs().fillna(0)
    ret = ret - turn * cost_bps / 10000.0

    if start:
        ret = ret.loc[ret.index >= start]

    equity = (1 + ret.fillna(0)).cumprod()
    num_switches = int((pos.diff().abs() > 0.001).loc[equity.index].sum())
    m = metrics(equity)
    tim = float((pos > 0).loc[equity.index].mean())
    return equity, Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd,
                           m.calmar, m.vol, tim, num_switches, m.years)


# ---------- runner ----------

def main():
    df = data_panel()
    df = df.dropna(subset=["spy_adj"])
    start = "2006-01-01"

    print(f"\nWindow: {start} → {df.index.max().date()}")
    print("=" * 130)

    # buy-and-hold benchmark
    eq_bh, m_bh, _ = simulate(df, strat_buyhold(df), start=start)
    print(m_bh.pretty("SPY buy-and-hold"))
    print("-" * 130)

    cfgs = [
        ("Faber 200-SMA",          lambda: strat_faber_sma(df, 200)),
        ("Faber 150-SMA",          lambda: strat_faber_sma(df, 150)),
        ("Faber 100-SMA",          lambda: strat_faber_sma(df, 100)),
        ("12m dual momentum",      lambda: strat_dual_momentum(df, 252)),
        ("6m dual momentum",       lambda: strat_dual_momentum(df, 126)),
        ("200-SMA + VIX<30",       lambda: strat_sma_vix(df, 200, 30.0)),
        ("200-SMA + VIX<25",       lambda: strat_sma_vix(df, 200, 25.0)),
        ("mBase >= 1",             lambda: strat_mbase_simple(df, 1)),
        ("mBase >= 3",             lambda: strat_mbase_simple(df, 3)),
        ("200-SMA + 12m mom + VIX",lambda: strat_sma_plus_momentum(df)),
    ]

    for name, fn in cfgs:
        pos = fn()
        eq, m, _ = simulate(df, pos, start=start)
        print(m.pretty(name))

    print("-" * 130)
    print("Leveraged / synthetic (with 200-SMA trend filter):")
    for lev, vix in [(2.0, None), (2.0, 25.0), (2.0, 30.0), (3.0, 25.0), (3.0, 30.0)]:
        tag = f"{lev}x SPY + SMA200"
        if vix is not None:
            tag += f" + VIX<{vix:.0f}"
        _, m = run_leveraged(df, n=200, lev=lev, vix_cap=vix, start=start)
        print(m.pretty(tag))


if __name__ == "__main__":
    main()
