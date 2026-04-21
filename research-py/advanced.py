"""Advanced strategies: vol-targeted leverage, multi-asset momentum, adaptive SMA."""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import Metrics, TRADING_DAYS, metrics
from strategies import data_panel


def equity_from_returns(ret: pd.Series, start: str | None = None) -> pd.Series:
    if start:
        ret = ret.loc[ret.index >= start]
    return (1 + ret.fillna(0)).cumprod()


def report(name: str, ret: pd.Series, pos: pd.Series | None = None, turnover: pd.Series | None = None,
           start: str = "2006-01-01"):
    eq = equity_from_returns(ret, start)
    m = metrics(eq)
    tim = float((pos.loc[eq.index] > 0).mean()) if pos is not None else 1.0
    sw = int((turnover.loc[eq.index] > 0.001).sum()) if turnover is not None else 0
    print(Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar,
                  m.vol, tim, sw, m.years).pretty(name))
    return eq


def strat_vol_targeted(df: pd.DataFrame, target_vol: float = 0.15, vol_lookback: int = 20,
                       max_lev: float = 3.0, sma_n: int = 200, cost_bps: float = 2.0) -> pd.Series:
    """Vol-target SPY exposure. Only on when above 200-SMA.
    Leverage = min(max_lev, target_vol / realized_vol). Recomputed daily, but cap turnover.
    """
    realized = df["spy_ret"].rolling(vol_lookback).std() * np.sqrt(TRADING_DAYS)
    raw_lev = (target_vol / realized).clip(0.0, max_lev).fillna(0)
    sma = df["spy_adj"].rolling(sma_n, min_periods=sma_n).mean()
    above = (df["spy_adj"] > sma).astype(float)
    lev = raw_lev * above

    # round leverage to 0.25 increments to cut trading churn
    lev = (lev * 4).round() / 4.0

    pos = lev.shift(1).fillna(0)
    expense_pa = 0.009
    cash_r = df["cash_ret"]
    # synthetic daily leveraged return
    lev_ret = pos * df["spy_ret"] - (pos - 1).clip(lower=0) * cash_r - (pos > 0) * expense_pa / TRADING_DAYS
    # when pos < 1, we're holding (1 - pos) cash
    lev_ret = lev_ret + (1 - pos).clip(lower=0) * cash_r
    turn = pos.diff().abs().fillna(0)
    net = lev_ret - turn * cost_bps / 10000.0
    return net, pos, turn


def strat_vol_targeted_v2(df: pd.DataFrame, target_vol: float = 0.15, vol_lookback: int = 20,
                          max_lev: float = 2.5, sma_n: int = 200, cost_bps: float = 2.0,
                          rebalance: str = "W") -> tuple[pd.Series, pd.Series, pd.Series]:
    """Vol-target with weekly rebalance to reduce turnover."""
    realized = df["spy_ret"].rolling(vol_lookback).std() * np.sqrt(TRADING_DAYS)
    raw_lev = (target_vol / realized).clip(0.0, max_lev).fillna(0)
    sma = df["spy_adj"].rolling(sma_n, min_periods=sma_n).mean()
    above = (df["spy_adj"] > sma).astype(float)
    lev = raw_lev * above

    # sample at rebalance frequency (W = weekly end-of-week)
    if rebalance == "W":
        sampled = lev.resample("W-FRI").last()
    elif rebalance == "M":
        sampled = lev.resample("ME").last()
    else:
        sampled = lev
    lev_rebalanced = sampled.reindex(df.index, method="ffill").fillna(0)

    pos = lev_rebalanced.shift(1).fillna(0)
    expense_pa = 0.009
    cash_r = df["cash_ret"]
    lev_ret = pos * df["spy_ret"] - (pos - 1).clip(lower=0) * cash_r - (pos > 0) * expense_pa / TRADING_DAYS
    lev_ret = lev_ret + (1 - pos).clip(lower=0) * cash_r
    turn = pos.diff().abs().fillna(0)
    net = lev_ret - turn * cost_bps / 10000.0
    return net, pos, turn


def strat_gem(df: pd.DataFrame, lookback: int = 252, cost_bps: float = 1.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Antonacci Global Equity Momentum: SPY vs T-bill 12m absolute momentum, then relative (SPY vs QQQ).
    Simplified: go to SPY if SPY > cash AND SPY > QQQ, QQQ if SPY > cash AND QQQ > SPY, else bonds (IEF)."""
    spy_12m = df["spy_adj"].pct_change(lookback)
    qqq_12m = df["qqq_ret"].add(1).rolling(lookback).apply(np.prod, raw=True) - 1
    cash_12m = df["cash_ret"].add(1).rolling(lookback).apply(np.prod, raw=True) - 1

    # target asset weights
    w_spy = pd.Series(0.0, index=df.index)
    w_qqq = pd.Series(0.0, index=df.index)
    w_ief = pd.Series(0.0, index=df.index)

    absolute_ok = spy_12m > cash_12m
    spy_wins = absolute_ok & (spy_12m >= qqq_12m)
    qqq_wins = absolute_ok & (qqq_12m > spy_12m)
    bonds = ~absolute_ok

    w_spy[spy_wins] = 1.0
    w_qqq[qqq_wins] = 1.0
    w_ief[bonds] = 1.0

    p_spy = w_spy.shift(1).fillna(0)
    p_qqq = w_qqq.shift(1).fillna(0)
    p_ief = w_ief.shift(1).fillna(0)

    ret = p_spy * df["spy_ret"] + p_qqq * df["qqq_ret"] + p_ief * df["ief_ret"]
    pos = p_spy + p_qqq + p_ief
    turn = (p_spy.diff().abs() + p_qqq.diff().abs() + p_ief.diff().abs()).fillna(0)
    net = ret - turn * cost_bps / 10000.0
    return net, pos, turn


def strat_gtaa5(df: pd.DataFrame, n: int = 200, cost_bps: float = 1.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Faber GTAA-5: equal-weight 5 asset classes, own only those above their 10-month SMA.
    Classes: SPY (stocks), QQQ (tech), TLT (long bonds), IEF (med bonds), GLD (gold).
    When an asset is below SMA -> its weight goes to cash.
    """
    classes = ["spy", "qqq", "tlt", "ief", "gld"]
    price = {
        "spy": df["spy_adj"],
        "qqq": (1 + df["qqq_ret"]).cumprod(),
        "tlt": (1 + df["tlt_ret"]).cumprod(),
        "ief": (1 + df["ief_ret"]).cumprod(),
        "gld": (1 + df["gld_ret"]).cumprod(),
    }
    ret = {
        "spy": df["spy_ret"],
        "qqq": df["qqq_ret"],
        "tlt": df["tlt_ret"],
        "ief": df["ief_ret"],
        "gld": df["gld_ret"],
    }

    weights = {}
    for c in classes:
        sma = price[c].rolling(n, min_periods=n).mean()
        weights[c] = ((price[c] > sma).astype(float) * 0.2).shift(1).fillna(0)

    port_ret = sum(weights[c] * ret[c] for c in classes)
    total_risk = sum(weights[c] for c in classes)
    cash_weight = 1.0 - total_risk
    port_ret = port_ret + cash_weight * df["cash_ret"]

    turn = sum(weights[c].diff().abs() for c in classes).fillna(0)
    net = port_ret - turn * cost_bps / 10000.0
    return net, total_risk, turn


def strat_vol_managed_spy(df: pd.DataFrame, target_vol: float = 0.12, vol_lookback: int = 20,
                          max_lev: float = 1.5, cost_bps: float = 1.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Moreira-Muir vol-managed portfolio: scale SPY by (target_vol / realized_vol). No trend filter.
    Published result: outperforms buy-hold by ~1-2% CAGR with better Sharpe."""
    realized = df["spy_ret"].rolling(vol_lookback).std() * np.sqrt(TRADING_DAYS)
    lev = (target_vol / realized).clip(0.0, max_lev).fillna(0)
    # round to 0.1 increments
    lev = (lev * 10).round() / 10.0
    pos = lev.shift(1).fillna(0)
    cash_r = df["cash_ret"]
    expense_pa = 0.005  # lighter because less leverage
    lev_ret = pos * df["spy_ret"] - (pos - 1).clip(lower=0) * cash_r - (pos > 0) * expense_pa / TRADING_DAYS
    lev_ret = lev_ret + (1 - pos).clip(lower=0) * cash_r
    turn = pos.diff().abs().fillna(0)
    net = lev_ret - turn * cost_bps / 10000.0
    return net, pos, turn


def strat_sma_delayed_exit(df: pd.DataFrame, n: int = 200, confirm_days: int = 5, lev: float = 2.0,
                           cost_bps: float = 2.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Reduce SMA whipsaw: require N consecutive closes below SMA before exit."""
    sma = df["spy_adj"].rolling(n, min_periods=n).mean()
    below = (df["spy_adj"] < sma).astype(int)
    # exit when below for `confirm_days` in a row
    below_streak = below.groupby((below != below.shift()).cumsum()).cumsum()
    exit_sig = below_streak >= confirm_days
    above = (df["spy_adj"] > sma).astype(int)
    # state machine: 1 when above SMA OR (below but not yet confirmed exit), 0 otherwise
    pos_raw = pd.Series(0, index=df.index, dtype=float)
    cur = 0
    for i in range(len(df)):
        if above.iloc[i]:
            cur = 1
        elif exit_sig.iloc[i]:
            cur = 0
        pos_raw.iloc[i] = cur
    pos_raw = pos_raw * lev
    pos = pos_raw.shift(1).fillna(0)
    cash_r = df["cash_ret"]
    lev_ret = pos * df["spy_ret"] - (pos - 1).clip(lower=0) * cash_r - (pos > 0) * 0.009 / TRADING_DAYS
    lev_ret = lev_ret + (1 - pos).clip(lower=0) * cash_r
    turn = pos.diff().abs().fillna(0)
    net = lev_ret - turn * cost_bps / 10000.0
    return net, pos, turn


def strat_sma_regime_leverage(df: pd.DataFrame, cost_bps: float = 2.0) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Regime-dependent leverage:
       above 200-SMA AND VIX<20           -> 3x
       above 200-SMA AND VIX in [20, 30]  -> 2x
       above 200-SMA AND VIX in [30, 40]  -> 1x
       below 200-SMA                      -> cash
    """
    sma = df["spy_adj"].rolling(200, min_periods=200).mean()
    above = df["spy_adj"] > sma
    vix = df["vix"]

    lev = pd.Series(0.0, index=df.index)
    lev[above & (vix < 20)] = 3.0
    lev[above & (vix >= 20) & (vix < 30)] = 2.0
    lev[above & (vix >= 30) & (vix < 40)] = 1.0
    lev[above & (vix >= 40)] = 0.0

    pos = lev.shift(1).fillna(0)
    cash_r = df["cash_ret"]
    expense_pa = 0.009
    lev_ret = pos * df["spy_ret"] - (pos - 1).clip(lower=0) * cash_r - (pos > 0) * expense_pa / TRADING_DAYS
    lev_ret = lev_ret + (1 - pos).clip(lower=0) * cash_r
    turn = pos.diff().abs().fillna(0)
    net = lev_ret - turn * cost_bps / 10000.0
    return net, pos, turn


def main():
    df = data_panel().dropna(subset=["spy_adj"]).copy()
    start = "2006-01-01"
    print(f"\nWindow: {start} → {df.index.max().date()}")
    print("=" * 130)

    eq_bh = (1 + df["spy_ret"].loc[start:]).cumprod()
    m_bh = metrics(eq_bh)
    print(Metrics(m_bh.cagr, m_bh.total_return, m_bh.sharpe, m_bh.sortino, m_bh.max_dd,
                  m_bh.calmar, m_bh.vol, 1.0, 0, m_bh.years).pretty("SPY buy-and-hold"))
    print("-" * 130)

    # Baseline lev strategies from before
    sma = df["spy_adj"].rolling(200, min_periods=200).mean()
    above = (df["spy_adj"] > sma).astype(float)
    for lev in [2.0, 3.0]:
        pos = (above * lev).shift(1).fillna(0)
        lev_ret = pos * df["spy_ret"] - (pos - 1).clip(lower=0) * df["cash_ret"] - (pos > 0) * 0.009 / TRADING_DAYS
        lev_ret = lev_ret + (1 - pos).clip(lower=0) * df["cash_ret"]
        turn = pos.diff().abs().fillna(0)
        net = lev_ret - turn * 2.0 / 10000.0
        report(f"{lev}x SPY + SMA200 (baseline)", net, pos, turn, start)

    print()
    print("VOL-TARGETED:")
    for tv in [0.12, 0.15, 0.18]:
        for ml in [2.0, 3.0]:
            net, pos, turn = strat_vol_targeted(df, target_vol=tv, max_lev=ml, sma_n=200)
            report(f"VolTgt={tv:.2f} max{ml}x +SMA200 daily", net, pos, turn, start)
    print()
    for tv, ml, freq in [(0.15, 2.5, "W"), (0.15, 3.0, "W"), (0.18, 3.0, "W"), (0.15, 2.5, "M"), (0.18, 3.0, "M")]:
        net, pos, turn = strat_vol_targeted_v2(df, target_vol=tv, max_lev=ml, sma_n=200, rebalance=freq)
        report(f"VolTgt={tv:.2f} max{ml}x +SMA200 {freq}", net, pos, turn, start)

    print()
    print("VOL-MANAGED (no trend filter):")
    for tv, ml in [(0.12, 1.5), (0.15, 1.5), (0.12, 2.0)]:
        net, pos, turn = strat_vol_managed_spy(df, target_vol=tv, max_lev=ml)
        report(f"VolManaged {tv:.2f} max{ml}x", net, pos, turn, start)

    print()
    print("MULTI-ASSET MOMENTUM:")
    net, pos, turn = strat_gem(df, lookback=252)
    report("GEM (SPY/QQQ/IEF 12m mom)", net, pos, turn, start)
    net, pos, turn = strat_gem(df, lookback=126)
    report("GEM (6m mom)", net, pos, turn, start)
    net, pos, turn = strat_gtaa5(df, n=200)
    report("Faber GTAA-5 (200-SMA)", net, pos, turn, start)
    net, pos, turn = strat_gtaa5(df, n=150)
    report("Faber GTAA-5 (150-SMA)", net, pos, turn, start)

    print()
    print("SMA WHIPSAW REDUCTION:")
    for d in [3, 5, 10]:
        for lev in [2.0, 3.0]:
            net, pos, turn = strat_sma_delayed_exit(df, n=200, confirm_days=d, lev=lev)
            report(f"{lev}x +SMA200 confirm={d}d", net, pos, turn, start)

    print()
    print("REGIME-LEVERAGE:")
    net, pos, turn = strat_sma_regime_leverage(df)
    report("VIX-regime leverage (1-3x)", net, pos, turn, start)


if __name__ == "__main__":
    main()
