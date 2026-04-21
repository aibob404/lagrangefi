"""Walk-forward validation + sub-period decomposition + monthly-rebalance variants."""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import TRADING_DAYS, metrics, Metrics
from strategies import data_panel, strat_faber_sma, simulate, run_leveraged


def subperiod(df, start: str, end: str) -> pd.DataFrame:
    m = (df.index >= start) & (df.index <= end)
    return df.loc[m].copy()


def report_period(df, start: str, end: str, label: str):
    sub = subperiod(df, start, end)
    if len(sub) < 50:
        return
    print(f"\n===  {label}  ({start} → {end})  ===")
    # baselines
    eq_bh = (1 + sub["spy_ret"]).cumprod()
    m_bh = metrics(eq_bh)
    print(Metrics(m_bh.cagr, m_bh.total_return, m_bh.sharpe, m_bh.sortino, m_bh.max_dd,
                  m_bh.calmar, m_bh.vol, 1.0, 0, m_bh.years).pretty("SPY buy-and-hold"))

    # 200-SMA (recompute on this subperiod prefixed with prior warmup)
    full = df[df.index <= end]
    sma200 = full["spy_adj"].rolling(200, min_periods=200).mean()
    pos = (full["spy_adj"] > sma200).astype(float).reindex(sub.index).fillna(0)
    pos_lagged = pos.shift(1).fillna(0)
    ret = pos_lagged * sub["spy_ret"] + (1 - pos_lagged) * sub["cash_ret"]
    turn = pos_lagged.diff().abs().fillna(0)
    ret = ret - turn * 1.0 / 10000.0
    eq = (1 + ret.fillna(0)).cumprod()
    m = metrics(eq)
    print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                  m.vol, float((pos_lagged > 0).mean()), int((pos_lagged.diff().abs() > 0.001).sum()), m.years)
          .pretty("Faber 200-SMA"))

    # 2x SPY + 200-SMA
    # reuse run_leveraged but trim its output to this window
    eq_full, _ = run_leveraged(df, n=200, lev=2.0, vix_cap=None, start=None)
    eq_sub = eq_full.loc[sub.index[0]:sub.index[-1]]
    eq_sub = eq_sub / eq_sub.iloc[0]
    m = metrics(eq_sub)
    print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                  m.vol, 1.0, 0, m.years).pretty("2x SPY + SMA200"))

    # 3x + SMA200 + VIX<30
    eq_full3, _ = run_leveraged(df, n=200, lev=3.0, vix_cap=30.0, start=None)
    eq_sub3 = eq_full3.loc[sub.index[0]:sub.index[-1]]
    eq_sub3 = eq_sub3 / eq_sub3.iloc[0]
    m = metrics(eq_sub3)
    print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                  m.vol, 1.0, 0, m.years).pretty("3x SPY + SMA200 + VIX<30"))


def monthly_rebalance_signal(daily_signal: pd.Series) -> pd.Series:
    """Convert a daily signal into a monthly-sampled signal (end-of-month only)."""
    monthly = daily_signal.resample("ME").last()
    # propagate monthly value forward through each trading day of the following month
    return monthly.reindex(daily_signal.index, method="ffill").fillna(0)


def main():
    df = data_panel().dropna(subset=["spy_adj"]).copy()

    print("\n" + "=" * 130)
    print("WALK-FORWARD VALIDATION: split history into train/test halves.")
    print("=" * 130)
    report_period(df, "2006-01-01", "2015-12-31", "TRAIN: 2006-2015")
    report_period(df, "2016-01-01", "2026-04-20", "TEST: 2016-2026")

    print("\n" + "=" * 130)
    print("SUB-PERIOD DECOMPOSITION (stress tests):")
    print("=" * 130)
    report_period(df, "2007-10-01", "2009-03-31", "GFC crash")
    report_period(df, "2009-04-01", "2019-12-31", "Post-GFC bull")
    report_period(df, "2020-02-15", "2020-05-15", "COVID crash")
    report_period(df, "2022-01-01", "2022-12-31", "2022 bear")
    report_period(df, "2023-01-01", "2024-12-31", "2023-2024 recovery")

    print("\n" + "=" * 130)
    print("MONTHLY-REBALANCE variants (lower turnover):")
    print("=" * 130)
    start = "2006-01-01"

    eq_bh = (1 + df.loc[start:]["spy_ret"]).cumprod()
    m_bh = metrics(eq_bh)
    print(Metrics(m_bh.cagr, m_bh.total_return, m_bh.sharpe, m_bh.sortino, m_bh.max_dd,
                  m_bh.calmar, m_bh.vol, 1.0, 0, m_bh.years).pretty("SPY buy-and-hold"))

    for n in [200, 150, 100]:
        sig = strat_faber_sma(df, n)
        sig_m = monthly_rebalance_signal(sig)
        eq, m, sw = simulate(df, sig_m, start=start, cost_bps=1.0)
        print(m.pretty(f"Faber {n}-SMA monthly"))

    # Leveraged with monthly rebalance
    print()
    for lev, vix in [(2.0, None), (2.0, 30.0), (3.0, 30.0)]:
        sma200 = df["spy_adj"].rolling(200, min_periods=200).mean()
        cond = df["spy_adj"] > sma200
        if vix is not None:
            cond = cond & (df["vix"] < vix)
        sig = cond.astype(float)
        sig_m = monthly_rebalance_signal(sig)
        pos = sig_m.shift(1).fillna(0)
        lev_ret = lev * df["spy_ret"] - (lev - 1) * df["cash_ret"] - 0.009 / TRADING_DAYS
        ret = pos * lev_ret + (1 - pos) * df["cash_ret"]
        turn = pos.diff().abs().fillna(0)
        ret = ret - turn * 2.0 / 10000.0
        ret = ret.loc[ret.index >= start]
        equity = (1 + ret.fillna(0)).cumprod()
        m = metrics(equity)
        tim = float((pos > 0).loc[equity.index].mean())
        sw = int((pos.diff().abs() > 0.001).loc[equity.index].sum())
        tag = f"{lev}x monthly + SMA200" + (f" + VIX<{vix:.0f}" if vix else "")
        print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                      m.vol, tim, sw, m.years).pretty(tag))


if __name__ == "__main__":
    main()
