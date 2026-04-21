"""Port the SPY SMA-trend strategy to BTC/ETH/SOL perps on Hyperliquid.

Key differences vs equities:
- 24/7 market, no overnight gaps (365 days/yr vs ~252 for stocks)
- Much higher volatility (60-90% annualized vs 15-20% for SPY)
- Funding cost: going long perps costs ~15% APR in funding (BTC) → significant drag
- Max leverage much higher (40x BTC on HL) but vol-drag is brutal
- Shorter history (HL perps data since 2024 = only 2.3 years)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import DAYS_PER_YEAR, load_candles, load_funding, metrics, summarize, sma


def build_panel(coin: str) -> pd.DataFrame:
    """Combine daily candles + daily-aggregated funding for one coin."""
    candles = load_candles(coin, "1d")[["open", "high", "low", "close", "volume"]]
    funding = load_funding(coin)[["fundingRate"]]

    # Aggregate hourly funding to daily total (each row is the 8-hr? check — actually hourly on HL)
    # HL pays every hour, so daily funding = sum of 24 hourly rates.
    daily_funding = funding["fundingRate"].resample("D").sum()
    daily_funding.name = "funding_daily"
    # Also annualized funding rate for display
    # funding per hour * 24 * 365 = annualized
    daily_fund_apr = funding["fundingRate"].resample("D").mean() * 24 * 365
    daily_fund_apr.name = "funding_apr"

    df = candles.join(daily_funding, how="left").join(daily_fund_apr, how="left")
    df["funding_daily"] = df["funding_daily"].fillna(0)
    df["funding_apr"] = df["funding_apr"].ffill()
    df["ret"] = df["close"].pct_change().fillna(0)
    return df


def simulate(df: pd.DataFrame, pos: pd.Series, cost_bps: float = 5.0,
             use_funding: bool = True) -> tuple[pd.Series, pd.Series]:
    """Return equity curve and trade-costs vector.
    Positive pos = long perp (pays funding when rate > 0).
    Negative pos = short perp (receives funding when rate > 0).
    Funding is daily_funding_rate * pos (long pays positive, short receives).
    """
    p = pos.shift(1).fillna(0)
    gross = p * df["ret"]
    if use_funding:
        # funding_daily is sum of hourly rates; positive means longs pay.
        # Long 1x: pays funding_daily. Short 1x: receives funding_daily.
        funding_cost = p * df["funding_daily"]
        gross = gross - funding_cost
    turn = p.diff().abs().fillna(0)
    costs = turn * cost_bps / 10000.0
    net = gross - costs
    equity = (1 + net.fillna(0)).cumprod()
    return equity, costs


def pos_buyhold(df):
    return pd.Series(1.0, index=df.index)


def pos_sma(df, n: int = 50, lev: float = 1.0):
    sma_n = sma(df["close"], n)
    return ((df["close"] > sma_n).astype(float) * lev)


def pos_sma_crypto(df, exit_n=100, entry_n=50, lev=1.0, hold_days=3):
    """Smart exit/entry adapted for crypto (shorter SMAs due to fewer bars)."""
    price = df["close"]
    sma_exit = sma(price, exit_n)
    sma_entry = sma(price, entry_n)
    below = (price < sma_exit).astype(int)
    exit_conf = below.rolling(hold_days).sum() >= hold_days

    pos = np.zeros(len(df), dtype=float)
    state = 0
    for i in range(len(df)):
        if np.isnan(sma_exit.iloc[i]) or np.isnan(sma_entry.iloc[i]):
            continue
        if state == 0 and price.iloc[i] > sma_entry.iloc[i]:
            state = 1
        elif state == 1 and exit_conf.iloc[i]:
            state = 0
        pos[i] = lev if state == 1 else 0.0
    return pd.Series(pos, index=df.index)


def pos_dual_trend(df, lev=1.0, fast=20, slow=50):
    """Hold long when fast MA > slow MA (simple crossover)."""
    fast_sma = sma(df["close"], fast)
    slow_sma = sma(df["close"], slow)
    return ((fast_sma > slow_sma).astype(float) * lev)


def pos_triple_sma(df, lev=1.0):
    """Hold long when price > SMA50 AND SMA20 > SMA50 AND SMA50 > SMA200."""
    price = df["close"]
    s20 = sma(price, 20)
    s50 = sma(price, 50)
    s200 = sma(price, 200)
    cond = (price > s50) & (s20 > s50) & (s50 > s200)
    return cond.astype(float) * lev


def main():
    coins = ["BTC", "ETH", "SOL"]
    print(f"\nHyperliquid daily candles: 2024-01-01 → 2026-04-21 (~2.3 years)")
    print(f"Funding cost included (avg ~15% APR for longs on BTC)")
    print("=" * 150)

    for coin in coins:
        df = build_panel(coin)
        df = df.loc[df.index >= "2024-01-01"]

        print(f"\n{'═' * 130}")
        print(f"  {coin} — days: {len(df)}   avg funding APR: {df['funding_apr'].mean()*100:.2f}%   "
              f"realized vol: {(df['ret'].std()*np.sqrt(DAYS_PER_YEAR))*100:.1f}%")
        print("═" * 130)

        # Benchmark
        eq, _ = simulate(df, pos_buyhold(df), use_funding=False)
        summarize(f"{coin} spot buy-and-hold", eq)

        # Buy-and-hold perp (pays funding — includes drag)
        eq, _ = simulate(df, pos_buyhold(df), use_funding=True)
        summarize(f"{coin} perp long (pays funding)", eq)
        print("-" * 150)

        # SMA variants
        for n in [20, 50, 100, 200]:
            for lev in [1.0, 2.0, 3.0]:
                if n >= len(df) - 10:
                    continue
                pos = pos_sma(df, n, lev)
                eq, _ = simulate(df, pos, use_funding=True)
                summarize(f"{coin} SMA{n} lev={lev}x", eq, pos)
        print()

        for lev in [1.0, 2.0, 3.0]:
            pos = pos_sma_crypto(df, 100, 50, lev, 3)
            eq, _ = simulate(df, pos, use_funding=True)
            summarize(f"{coin} smart 100/50 hold=3 lev={lev}x", eq, pos)

        for lev in [1.0, 2.0, 3.0]:
            pos = pos_sma_crypto(df, 50, 20, lev, 3)
            eq, _ = simulate(df, pos, use_funding=True)
            summarize(f"{coin} smart 50/20 hold=3 lev={lev}x", eq, pos)

        for lev in [1.0, 2.0, 3.0]:
            pos = pos_dual_trend(df, lev, 20, 50)
            eq, _ = simulate(df, pos, use_funding=True)
            summarize(f"{coin} MA20>MA50 lev={lev}x", eq, pos)

        for lev in [1.0, 2.0, 3.0]:
            pos = pos_triple_sma(df, lev)
            eq, _ = simulate(df, pos, use_funding=True)
            summarize(f"{coin} triple-SMA gate lev={lev}x", eq, pos)


if __name__ == "__main__":
    main()
