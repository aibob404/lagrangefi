"""Delta-neutral funding harvest with REAL spot prices from OKX.

Simulates:
  Day t: hold 1 unit long OKX spot + 1 unit short HL perp
  Day t+1 PnL:
    spot_ret from real spot prices
    perp_ret from HL perp
    funding_pnl: sum of hourly funding rates over the day (short receives when rate > 0)
  Costs: 10 bps round-trip on entry/exit; 2 bps per rebalance (monthly)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from common import load_candles, load_funding, metrics, summarize


DATA = Path(__file__).parent / "data"


def load_spot(coin: str) -> pd.DataFrame:
    path = DATA / f"spot_{coin}_1d.csv"
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df.index = pd.to_datetime(df.index, format="ISO8601", utc=True).tz_localize(None).normalize()
    df.index.name = "time"
    return df.sort_index()


def harvest_real(coin: str, start: str = "2024-01-01",
                 tx_cost_bps: float = 10.0,
                 rebalance_days: int = 30,
                 cash_yield_apr: float = 0.04) -> tuple[pd.DataFrame, pd.Series]:
    """Delta-neutral with real spot + perp; everything aligned to daily bars."""
    perp = load_candles(coin, "1d")["close"].rename("perp")
    # normalize index to midnight
    perp.index = perp.index.normalize()
    spot = load_spot(coin)["close"].rename("spot")
    # align
    idx = perp.index.intersection(spot.index)
    perp = perp.reindex(idx)
    spot = spot.reindex(idx)

    # funding aggregated daily
    funding = load_funding(coin)["fundingRate"]
    daily_funding = funding.resample("D").sum()
    daily_funding.index = daily_funding.index.normalize()
    funding_pnl = daily_funding.reindex(idx).fillna(0)

    spot_ret = spot.pct_change().fillna(0)
    perp_ret = perp.pct_change().fillna(0)

    # delta-neutral: spot_ret - perp_ret + funding_pnl
    delta_pnl = spot_ret - perp_ret
    gross = delta_pnl + funding_pnl

    # costs
    cost_event = pd.Series(0.0, index=idx)
    cost_event.iloc[0] = (2 * tx_cost_bps / 2) / 10000.0
    for i in range(rebalance_days, len(cost_event), rebalance_days):
        cost_event.iloc[i] = 2 / 10000.0  # 2 bps per monthly rebalance
    cost_event.iloc[-1] += (2 * tx_cost_bps / 2) / 10000.0

    net = gross - cost_event
    equity = (1 + net.fillna(0)).cumprod()

    df = pd.DataFrame({
        "perp": perp, "spot": spot,
        "spot_ret": spot_ret, "perp_ret": perp_ret,
        "funding_pnl": funding_pnl, "delta_pnl": delta_pnl,
        "gross": gross, "cost": cost_event, "net": net,
    })
    df = df.loc[df.index >= start]
    equity = (1 + df["net"].fillna(0)).cumprod()
    return df, equity


def conditional_harvest_real(coin: str, start: str = "2024-01-01",
                              min_apr: float = 0.08, tx_cost_bps: float = 10.0,
                              cash_yield_apr: float = 0.04):
    """Only in trade when 7-day rolling APR > threshold. Earn cash yield otherwise."""
    df_full, _ = harvest_real(coin, start="2024-01-01")
    # 7-day rolling APR = 7-day sum of funding * (365/7)
    apr_7d = df_full["funding_pnl"].rolling(7, min_periods=1).sum() * (365 / 7)
    in_trade = (apr_7d > min_apr).astype(float).shift(1).fillna(0)

    cash_daily = cash_yield_apr / 365
    gross = in_trade * df_full["gross"] + (1 - in_trade) * cash_daily
    turn = in_trade.diff().abs().fillna(0)
    # each toggle: 2 legs at tx_cost_bps/2 per side
    cost = turn * (2 * tx_cost_bps / 2) / 10000.0
    cost.iloc[0] += in_trade.iloc[0] * (2 * tx_cost_bps / 2) / 10000.0
    net = gross - cost
    equity = (1 + net.fillna(0)).cumprod()
    equity = equity.loc[equity.index >= start]
    return equity, in_trade


def basket_harvest_real(coins: list[str], weights: dict[str, float] | None = None,
                        start: str = "2024-01-01"):
    """Equal-weight delta-neutral basket."""
    if weights is None:
        weights = {c: 1 / len(coins) for c in coins}
    rets = {}
    for c in coins:
        df, _ = harvest_real(c, start=start)
        rets[c] = df["net"]
    all_r = pd.DataFrame(rets).fillna(0)
    port = sum(all_r[c] * weights[c] for c in coins)
    eq = (1 + port.fillna(0)).cumprod()
    return eq


def top_apr_rotation_real(coins: list[str], top_n: int = 3, start: str = "2024-02-01",
                          tx_cost_bps: float = 10.0):
    """Each week, pick top-N by trailing 7-day APR. Equal weight."""
    panels = {}
    all_idx = set()
    for c in coins:
        df, _ = harvest_real(c, start="2024-01-01")
        panels[c] = df
        all_idx |= set(df.index)
    idx = pd.DatetimeIndex(sorted(all_idx))

    apr_by_coin = pd.DataFrame({
        c: panels[c]["funding_pnl"].rolling(7, min_periods=1).sum() * (365 / 7)
        for c in coins
    }).reindex(idx).ffill()
    gross_by_coin = pd.DataFrame({c: panels[c]["gross"] for c in coins}).reindex(idx).fillna(0)

    # weekly rebalance
    weekly_dates = pd.date_range(idx[0], idx[-1], freq="W-MON")
    weights = pd.DataFrame(0.0, index=idx, columns=coins)
    last_wd = None
    for wd in weekly_dates:
        near = idx[idx >= wd]
        if len(near) == 0:
            continue
        actual = near[0]
        snapshot = apr_by_coin.loc[actual]
        top = snapshot.nlargest(top_n).index.tolist()
        # only allocate if APR > 5% (else stay cash)
        top = [t for t in top if snapshot[t] > 0.05]
        if not top:
            continue
        w = {t: 1 / len(top) for t in top}
        # apply forward until next weekly
        for c in coins:
            weights.loc[weights.index >= actual, c] = w.get(c, 0.0)

    weights = weights.shift(1).fillna(0)
    ret = (weights * gross_by_coin).sum(axis=1)
    turn = weights.diff().abs().sum(axis=1).fillna(0)
    cost = turn * tx_cost_bps / 10000.0
    # cash yield when out
    cash_daily = 0.04 / 365
    fully_out = weights.sum(axis=1) < 0.01
    net = np.where(fully_out, cash_daily, ret - cost)
    net = pd.Series(net, index=idx)
    eq = (1 + net.fillna(0)).cumprod()
    return eq.loc[eq.index >= start], weights


def main():
    coins = ["BTC", "ETH", "SOL", "AVAX", "LINK", "ARB", "OP", "BNB", "DOGE"]
    print("\n" + "=" * 140)
    print(f"  REAL SPOT-BASED funding harvest (OKX spot - HL perp)")
    print(f"  2024-01-01 → 2026-04-20   (delta-neutral: long OKX spot, short HL perp)")
    print(f"  Costs: 10 bps round-trip entry/exit, 2 bps/month rebalance. Cash yield: 4% APR when out.")
    print("=" * 140)

    print("\n--- Static always-in harvest ---\n")
    for c in coins:
        try:
            df, eq = harvest_real(c)
            avg_apr = df["funding_pnl"].sum() / (len(df) / 365)
            bas = df["delta_pnl"].sum()
            print(f"{c:5s}  funding TR {df['funding_pnl'].sum()*100:5.2f}%  basis TR {bas*100:+5.2f}%  combined TR {df['gross'].sum()*100:+5.2f}%")
            summarize(f"{c} real delta-neutral", eq)
        except Exception as e:
            print(f"{c}: {e}")
    print()

    print("\n--- Conditional (only in when 7d APR > threshold) ---\n")
    for c in ["BTC", "ETH", "SOL", "LINK", "DOGE"]:
        for thr in [0.05, 0.10, 0.15]:
            eq, sig = conditional_harvest_real(c, min_apr=thr)
            tim = float(sig.mean())
            summarize(f"{c} APR>{thr*100:.0f}% (in trade {tim*100:.0f}%)", eq)

    print("\n--- Equal-weight basket ---\n")
    eq = basket_harvest_real(coins)
    summarize(f"Equal-weight {len(coins)}-coin basket", eq)

    print("\n--- Top-3 APR rotation (weekly) ---\n")
    eq, _ = top_apr_rotation_real(coins, top_n=3)
    summarize("Top-3 APR weekly rotation", eq)
    eq, _ = top_apr_rotation_real(coins, top_n=5)
    summarize("Top-5 APR weekly rotation", eq)


if __name__ == "__main__":
    main()
