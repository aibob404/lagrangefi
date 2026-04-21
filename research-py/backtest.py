"""Core backtest: macro-timed rotation between SPY and cash/TLT."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from common import load, load_close, metrics, Metrics, TRADING_DAYS
from macro_engine import build_panel, macro_score


@dataclass
class RotationConfig:
    long_threshold: int = 1       # go long SPY when mbase >= this
    flat_threshold: int = 0       # go flat (cash) when mbase <= this  (hysteresis)
    hedge_threshold: int | None = None  # switch to TLT/bonds when mbase <= this (None = cash only)
    vix_ceiling: float | None = None    # force flat if VIX > ceiling
    lag: int = 1                  # days between signal and execution
    cost_bps: float = 1.0         # transaction cost per one-way trade in bps
    cash_from: str = "IRX"        # IRX -> use 13w t-bill yield, or BIL -> BIL ETF returns


def _cash_returns(panel: pd.DataFrame, source: str) -> pd.Series:
    """Daily return of the 'cash' position."""
    if source == "IRX":
        y = panel["y3m"].ffill() / 100.0
        return (1 + y) ** (1 / TRADING_DAYS) - 1
    if source == "BIL":
        bil = load_close("BIL", "Adj Close").reindex(panel.index).ffill()
        return bil.pct_change().fillna(0.0)
    raise ValueError(f"unknown cash source: {source}")


def _hedge_returns(panel: pd.DataFrame) -> pd.Series:
    tlt = load_close("TLT", "Adj Close").reindex(panel.index).ffill()
    return tlt.pct_change().fillna(0.0)


def run_rotation(cfg: RotationConfig, scores: pd.DataFrame,
                 start: str | None = None, end: str | None = None) -> tuple[pd.Series, pd.DataFrame, Metrics]:
    """Run a rotation backtest. Returns (equity, state_df, metrics)."""
    df = scores.copy()
    if start:
        df = df.loc[df.index >= start]
    if end:
        df = df.loc[df.index <= end]
    df = df.dropna(subset=["mbase", "spy_adj"])

    spy_ret = df["spy_adj"].pct_change().fillna(0.0)
    cash_ret = _cash_returns(df, cfg.cash_from)
    hedge_ret = _hedge_returns(df) if cfg.hedge_threshold is not None else pd.Series(0.0, index=df.index)

    # Signal with hysteresis:
    #   state 1 (long SPY)  while mbase >= long_threshold
    #   state -1 (hedge)    while mbase <= hedge_threshold (if set)
    #   state 0 (cash)      otherwise
    mbase = df["mbase"].to_numpy()
    n = len(df)
    state = np.zeros(n, dtype=np.int8)
    cur = 0
    for i in range(n):
        m = mbase[i]
        if cfg.vix_ceiling is not None and df["vix"].iloc[i] > cfg.vix_ceiling:
            cur = 0
        elif cur == 1:
            if m < cfg.flat_threshold:
                cur = -1 if (cfg.hedge_threshold is not None and m <= cfg.hedge_threshold) else 0
        elif cur == -1:
            if m >= cfg.long_threshold:
                cur = 1
            elif cfg.hedge_threshold is None or m > cfg.hedge_threshold:
                cur = 0
        else:
            if m >= cfg.long_threshold:
                cur = 1
            elif cfg.hedge_threshold is not None and m <= cfg.hedge_threshold:
                cur = -1
        state[i] = cur

    df["state"] = state
    # apply lag: decision at close of day t -> position held from t+lag onwards
    pos = pd.Series(state, index=df.index).shift(cfg.lag).fillna(0).astype(int)
    df["pos"] = pos

    # per-day return: SPY when state=1, cash when state=0, TLT when state=-1
    ret = pd.Series(0.0, index=df.index)
    ret[pos == 1] = spy_ret[pos == 1]
    ret[pos == 0] = cash_ret[pos == 0]
    ret[pos == -1] = hedge_ret[pos == -1]

    # transaction cost on position changes (one-way trade each side)
    turn = pos.diff().abs().fillna(0)
    costs = turn * (cfg.cost_bps / 10000.0)
    net = ret - costs

    equity = (1 + net).cumprod()
    num_switches = int(((pos.diff().abs() > 0)).sum())

    time_in_mkt = float((pos != 0).mean())
    m = metrics(equity)
    m = Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd,
                m.calmar, m.vol, time_in_mkt, num_switches, m.years)
    return equity, df[["mbase", "state", "pos", "vix", "spy_adj"]], m


def buy_and_hold_spy(scores: pd.DataFrame, start: str | None = None, end: str | None = None) -> tuple[pd.Series, Metrics]:
    df = scores.dropna(subset=["spy_adj"]).copy()
    if start: df = df.loc[df.index >= start]
    if end: df = df.loc[df.index <= end]
    eq = df["spy_adj"] / df["spy_adj"].iloc[0]
    m = metrics(eq)
    return eq, m


if __name__ == "__main__":
    panel = build_panel()
    scores = macro_score(panel).dropna(subset=["mbase"])
    start = "2006-01-01"  # after sma200 + credit z-score warmup

    print(f"\nBacktest window: {start} → {scores.index.max().date()}")
    print("=" * 110)

    # Benchmark
    _, bh = buy_and_hold_spy(scores, start)
    print(bh.pretty("SPY buy-and-hold"))
    print("-" * 110)

    # Several threshold configs
    configs = [
        ("Rotation mbase>=0", RotationConfig(long_threshold=0, flat_threshold=-1)),
        ("Rotation mbase>=1", RotationConfig(long_threshold=1, flat_threshold=0)),
        ("Rotation mbase>=2", RotationConfig(long_threshold=2, flat_threshold=1)),
        ("Rotation mbase>=3", RotationConfig(long_threshold=3, flat_threshold=2)),
        ("Rotation mbase>=1 hysteresis", RotationConfig(long_threshold=1, flat_threshold=-1)),
        ("Rotation mbase>=2 hysteresis", RotationConfig(long_threshold=2, flat_threshold=0)),
        ("mbase>=1 + TLT hedge<=-2", RotationConfig(long_threshold=1, flat_threshold=-1, hedge_threshold=-2)),
        ("mbase>=2 + TLT hedge<=-1", RotationConfig(long_threshold=2, flat_threshold=0, hedge_threshold=-1)),
    ]
    for name, cfg in configs:
        _, _, m = run_rotation(cfg, scores, start)
        print(m.pretty(name))
