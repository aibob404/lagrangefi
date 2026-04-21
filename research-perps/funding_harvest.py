"""Delta-neutral funding harvest on Hyperliquid perps.

Strategy:
  Long 1 unit spot + short 1 unit perp
  Funding rate > 0 (longs pay shorts) → we collect funding as the short side
  Exposure is delta-neutral (modulo basis).

For a clean backtest we'd need spot prices from a separate venue (Binance, CoinGecko).
Approximation: perp price is very close to spot (funding drives convergence).
   spot_price ≈ perp_price / (1 + premium)
   where premium is embedded in the HL funding data.

Caveats:
- Borrow cost for spot (if shorting spot in a CEX). If self-funded with USDC, no cost.
- Transaction costs each rebalance: 5 bps per side on HL (conservative).
- Slippage assumption: 1 bp on liquid majors.
- Spot/perp basis risk: can widen during stress (2022 LUNA, March '20).
- Hourly funding on HL: we aggregate to daily for simplicity.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import load_candles, load_funding, metrics, summarize


def single_coin_funding(coin: str, start: str = "2024-01-01",
                        tx_cost_bps: float = 10.0,  # 5 bps each side to enter/exit
                        rebalance_days: int = 30) -> tuple[pd.DataFrame, pd.Series]:
    """Backtest static delta-neutral on one coin.

    Returns:
        daily_returns: series of per-day portfolio return (net of all costs)
        equity: cumulative equity curve starting at 1.0
    """
    candles = load_candles(coin, "1d")
    funding = load_funding(coin)

    # Aggregate funding to daily. HL pays per-hour. Daily funding = sum of hourly rates over the day.
    daily_funding = funding["fundingRate"].resample("D").sum()

    # basis / premium aggregation (mean of hourly premium)
    # premium column gives (perp - mark) / mark
    daily_premium = funding["premium"].resample("D").mean()

    perp_close = candles["close"]
    spot_approx = perp_close / (1 + daily_premium.reindex(perp_close.index).ffill())
    # spot and perp daily returns
    spot_ret = spot_approx.pct_change().fillna(0)
    perp_ret = perp_close.pct_change().fillna(0)

    # Delta-neutral: long 1 unit spot, short 1 unit perp (notional-matched)
    # Daily PnL = spot_ret - perp_ret + funding_collected
    # Funding collected by short = +funding_rate (when positive, shorts receive)
    delta_pnl = spot_ret - perp_ret
    funding_pnl = daily_funding.reindex(perp_close.index).fillna(0)
    # When premium is baked into spot approximation, the cumulative basis change is in delta_pnl.

    gross = delta_pnl + funding_pnl

    # Costs: rebalance every N days
    cost_event = pd.Series(0.0, index=perp_close.index)
    # Initial entry: 2 legs (spot + perp)
    cost_event.iloc[0] = 2 * (tx_cost_bps / 2) / 10000.0  # 2 sides at half of tx_cost each
    # Periodic rebalance (re-adjust notional to account for spot/perp divergence)
    reb_idx = np.arange(rebalance_days, len(cost_event), rebalance_days)
    # Each rebalance: adjust ~1-2% notional; cost scales with turnover.
    # Conservative: 2 bps per rebalance event.
    for i in reb_idx:
        cost_event.iloc[i] = 2 / 10000.0
    # Final exit: 2 legs
    cost_event.iloc[-1] += 2 * (tx_cost_bps / 2) / 10000.0

    net = gross - cost_event
    equity = (1 + net.fillna(0)).cumprod()

    df = pd.DataFrame({
        "perp_close": perp_close,
        "funding_daily": funding_pnl,
        "delta_pnl": delta_pnl,
        "gross": gross,
        "cost": cost_event,
        "net": net,
    }, index=perp_close.index)
    df = df.loc[df.index >= start]
    equity = (1 + df["net"].fillna(0)).cumprod()
    return df, equity


def pooled_funding(coins: list[str], weights: dict[str, float] | None = None,
                   start: str = "2024-01-01") -> tuple[pd.Series, dict[str, pd.Series]]:
    """Weighted portfolio of multiple funding-harvest positions."""
    eq_per = {}
    rets_per = {}
    for c in coins:
        df, eq = single_coin_funding(c, start=start)
        eq_per[c] = eq
        rets_per[c] = df["net"]

    if weights is None:
        weights = {c: 1 / len(coins) for c in coins}

    # align
    all_rets = pd.DataFrame(rets_per).fillna(0)
    port_ret = sum(all_rets[c] * weights[c] for c in coins)
    port_eq = (1 + port_ret.fillna(0)).cumprod()
    return port_eq, eq_per


def conditional_funding_harvest(coin: str, start: str = "2024-01-01",
                                min_apr: float = 0.05, tx_cost_bps: float = 10.0):
    """Only be in the trade when funding APR is above threshold.
    Reduces capital usage when funding is low.
    """
    candles = load_candles(coin, "1d")
    funding = load_funding(coin)

    daily_funding = funding["fundingRate"].resample("D").sum()
    # APR = (1+hourly_rate)^(24*365) - 1 ≈ hourly_rate * 24 * 365 for small rates
    hourly_avg = funding["fundingRate"].resample("D").mean()
    funding_apr = hourly_avg * 24 * 365

    daily_premium = funding["premium"].resample("D").mean()
    perp_close = candles["close"]
    spot_approx = perp_close / (1 + daily_premium.reindex(perp_close.index).ffill())
    spot_ret = spot_approx.pct_change().fillna(0)
    perp_ret = perp_close.pct_change().fillna(0)

    # Signal: be in the trade when rolling 7-day funding APR > min_apr
    signal_apr = funding_apr.reindex(perp_close.index).ffill()
    rolling_apr = signal_apr.rolling(7, min_periods=1).mean()
    in_trade = (rolling_apr > min_apr).astype(float).shift(1).fillna(0)

    delta_pnl = spot_ret - perp_ret
    funding_pnl = daily_funding.reindex(perp_close.index).fillna(0)

    # when in trade, delta+funding. When out, earn 0 (cash, we'd park in USDC earning stables yield).
    # assume cash earns 4% APR = 4%/365 daily
    cash_daily = 0.04 / 365
    gross = in_trade * (delta_pnl + funding_pnl) + (1 - in_trade) * cash_daily

    # costs on entry/exit (state change)
    state_change = in_trade.diff().abs().fillna(0)
    costs = state_change * (2 * tx_cost_bps / 2) / 10000.0  # spot+perp when toggling
    costs.iloc[0] += in_trade.iloc[0] * (2 * tx_cost_bps / 2) / 10000.0  # initial entry if in

    net = gross - costs
    equity = (1 + net.fillna(0)).cumprod()
    equity = equity.loc[equity.index >= start]
    return equity, in_trade


def main():
    majors = ["BTC", "ETH", "SOL", "AVAX", "LINK", "ARB", "OP", "BNB", "DOGE"]
    print("\n" + "=" * 140)
    print(f"  Funding harvest (delta-neutral: long spot + short perp) — HL 2024-01-01 → 2026-04-21")
    print(f"  Assumes 10 bps round-trip tx cost, monthly rebalance, USDC 4% APR when out of trade.")
    print("=" * 140)

    # Single-coin static harvest
    print("\n--- Static harvest (always in, rebalance monthly) ---\n")
    results = {}
    for c in majors:
        try:
            df, eq = single_coin_funding(c)
            m = summarize(f"{c} static harvest", eq)
            results[c] = (eq, m)
        except FileNotFoundError:
            print(f"  {c}: no data")

    # Pooled (equal-weight basket)
    print("\n--- Equal-weight basket ---\n")
    liquid_majors = ["BTC", "ETH", "SOL", "AVAX", "LINK", "ARB", "BNB", "DOGE"]
    port_eq, per_coin = pooled_funding(liquid_majors)
    summarize(f"Equal-weight basket ({len(liquid_majors)} coins)", port_eq)

    # Top-funding rotation: pick top 3 by rolling 7-day funding APR
    print("\n--- Top-funding rotation (top-3 by 7d avg APR) ---\n")
    rotation_eq = top_funding_rotation(liquid_majors)
    summarize(f"Top-3 rotation", rotation_eq)

    # Conditional harvest: only when APR > 5% or 8% or 10%
    print("\n--- Conditional single-coin (only in trade when APR > threshold) ---\n")
    for c in ["BTC", "ETH", "SOL"]:
        for thr in [0.05, 0.08, 0.12]:
            eq, sig = conditional_funding_harvest(c, min_apr=thr)
            tim = float(sig.mean())
            m = summarize(f"{c} APR>{thr*100:.0f}% (in {tim*100:.0f}%)", eq)


def top_funding_rotation(coins: list[str], top_n: int = 3, start: str = "2024-02-01") -> pd.Series:
    """Every week, pick top-N coins by rolling 7-day funding APR. Delta-neutral harvest."""
    # get per-coin daily funding and perp returns + spot approx
    panels = {}
    for c in coins:
        candles = load_candles(c, "1d")
        funding = load_funding(c)
        dfund = funding["fundingRate"].resample("D").sum()
        dprem = funding["premium"].resample("D").mean()
        perp = candles["close"]
        spot = perp / (1 + dprem.reindex(perp.index).ffill())
        panels[c] = pd.DataFrame({
            "funding": dfund.reindex(perp.index).fillna(0),
            "perp_ret": perp.pct_change().fillna(0),
            "spot_ret": spot.pct_change().fillna(0),
        })

    all_dates = sorted(set().union(*[p.index for p in panels.values()]))
    idx = pd.DatetimeIndex(all_dates)

    # per-day signal-APR = 7-day rolling funding sum * 52 (weekly → annual)
    apr_by_coin = pd.DataFrame({
        c: panels[c]["funding"].rolling(7, min_periods=1).sum() * (365 / 7)
        for c in coins
    }).reindex(idx).ffill()

    # every week (Monday), rebalance to equal-weight top-N
    weekly_dates = apr_by_coin.resample("W-MON").last().index
    weights = pd.DataFrame(0.0, index=idx, columns=coins)
    prev_top = []
    for wd in weekly_dates:
        if wd not in apr_by_coin.index:
            continue
        snapshot = apr_by_coin.loc[wd]
        top = snapshot.nlargest(top_n).index.tolist()
        for c in top:
            weights.loc[weights.index >= wd, c] = 1.0 / top_n
            weights.loc[weights.index >= wd, [x for x in coins if x not in top]] = 0.0
    # apply T+1 lag
    weights = weights.shift(1).fillna(0)

    # daily returns
    ret = pd.Series(0.0, index=idx)
    for c in coins:
        r = panels[c]["spot_ret"].reindex(idx).fillna(0) - panels[c]["perp_ret"].reindex(idx).fillna(0) + panels[c]["funding"].reindex(idx).fillna(0)
        ret += weights[c] * r

    # transaction cost on weekly rebalance
    turn = weights.diff().abs().sum(axis=1).fillna(0)
    # every weekly switch: enter new position (2 legs * tx/2 per side) — conservative 10 bps
    cost_bps = 10
    cost = turn * cost_bps / 10000.0
    net = ret - cost

    # when fully out (e.g. first week before signal), earn cash
    cash_daily = 0.04 / 365
    fully_out = (weights.sum(axis=1) < 0.01)
    net = np.where(fully_out, cash_daily, net)
    net = pd.Series(net, index=idx)
    eq = (1 + net.fillna(0)).cumprod()
    return eq.loc[eq.index >= start]


if __name__ == "__main__":
    main()
