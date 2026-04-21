"""Polymarket 'sell far-OTM' strategy: systematically buy NO on markets priced < threshold.

Thesis:
  Long-tail YES (e.g. "Will Jesus return by 2027" at 3.85%, "LeBron wins 2028 POTUS" at 0.65%)
  is systematically overpriced by retail gamblers. The NO side earns a small premium per trade
  that reliably resolves at $1.00.

Approach:
  1. Fetch resolved markets (archived=true).
  2. For each, get its price N days before resolution.
  3. Bucket by pre-price, compute actual YES resolution rate.
  4. Identify buckets where market is overpricing YES (i.e., pre_price > actual_yes_rate) → NO edge.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pandas as pd
import requests

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"

DATA = Path(__file__).parent / "data"


def fetch_archived(pages: int = 10, min_liquidity: float = 5000.0):
    all_m = []
    for page in range(pages):
        r = requests.get(f"{GAMMA}/markets",
                         params={"closed": "true", "archived": "true", "limit": 500,
                                 "offset": page * 500, "order": "endDate", "ascending": "false"},
                         timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        all_m.extend(batch)
        time.sleep(0.3)
    # Filter for reasonable liquidity and that have resolved with clear outcome
    filtered = []
    for m in all_m:
        liq = float(m.get("liquidity") or 0)
        vol = float(m.get("volume") or 0)
        # actually both often 0 post-close; filter on volume instead
        if vol < 500:
            continue
        try:
            outcomes_prices = json.loads(m.get("outcomePrices") or "[]")
            if len(outcomes_prices) != 2:
                continue
            # resolved markets have final outcomePrices = [1,0] or [0,1]
            p0, p1 = float(outcomes_prices[0]), float(outcomes_prices[1])
            if max(p0, p1) < 0.95:
                continue  # not cleanly resolved
        except Exception:
            continue
        filtered.append(m)
    return filtered


def get_price_snapshot(token_id: str, ts: int) -> float | None:
    """Get price at specific unix timestamp via CLOB prices-history.
    Returns the closest price AT OR BEFORE ts.
    """
    # fetch full history at hourly
    try:
        r = requests.get(f"{CLOB}/prices-history",
                         params={"market": token_id, "interval": "max", "fidelity": 60},
                         timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        hist = data.get("history", [])
        if not hist:
            return None
        pts = [(p["t"], p["p"]) for p in hist if p["t"] <= ts]
        if not pts:
            return None
        return float(pts[-1][1])
    except Exception:
        return None


def analyze(markets: list[dict], lookback_days: int = 7, max_markets: int = 200):
    rows = []
    for i, m in enumerate(markets[:max_markets]):
        try:
            tokens = json.loads(m.get("clobTokenIds") or "[]")
            outcome_prices = json.loads(m.get("outcomePrices") or "[]")
        except Exception:
            continue
        if len(tokens) != 2 or len(outcome_prices) != 2:
            continue
        end_str = m.get("endDate")
        if not end_str:
            continue
        try:
            end_ts = int(pd.to_datetime(end_str).timestamp())
        except Exception:
            continue
        snapshot_ts = end_ts - lookback_days * 86400
        # yes token is index 0
        pre = get_price_snapshot(tokens[0], snapshot_ts)
        if pre is None:
            continue
        yes_won = float(outcome_prices[0]) > 0.5
        rows.append({
            "question": (m.get("question") or "")[:80],
            "pre_price_yes": pre,
            "yes_won": yes_won,
            "volume": float(m.get("volume") or 0),
            "end": m.get("endDate"),
        })
        time.sleep(0.05)
        if i % 50 == 49:
            print(f"  processed {i+1}/{min(len(markets), max_markets)}  collected={len(rows)}")
    return pd.DataFrame(rows)


def backtest_no_longshot(results: pd.DataFrame, max_yes_price: float = 0.10,
                         assume_hold_days: int = 30):
    """Simulate: buy NO whenever yes_price <= threshold, hold to resolution."""
    sel = results[results["pre_price_yes"] <= max_yes_price].copy()
    if sel.empty:
        return None
    sel["no_entry"] = 1 - sel["pre_price_yes"]  # price of NO
    sel["payoff"] = sel["yes_won"].apply(lambda yw: 0.0 if yw else 1.0)
    # profit per $1 staked on NO = payoff/no_entry - 1
    sel["return_pct"] = (sel["payoff"] / sel["no_entry"]) - 1
    return sel


def main():
    print("Fetching archived (resolved) Polymarket markets...")
    markets = fetch_archived(pages=8, min_liquidity=5000)
    print(f"  {len(markets)} resolved markets with clear YES/NO")

    print(f"\nQuerying price snapshots {7} days before resolution...")
    df = analyze(markets, lookback_days=7, max_markets=600)
    df.to_csv(DATA / "pm_resolved_snapshots.csv", index=False)
    print(f"  {len(df)} markets with price data")

    if df.empty:
        return

    # Calibration table: bucket by pre-price, show actual YES rate
    bins = [0, 0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 0.80, 0.90, 0.95, 1.01]
    df["bucket"] = pd.cut(df["pre_price_yes"], bins=bins)
    agg = df.groupby("bucket", observed=True).agg(
        n=("yes_won", "size"),
        mid_bucket=("pre_price_yes", "mean"),
        actual_yes_rate=("yes_won", "mean"),
    ).reset_index()
    agg["yes_edge_bps"] = (agg["actual_yes_rate"] - agg["mid_bucket"]) * 10000
    print(f"\nCalibration {7}d-before-resolution (all buckets):")
    print(agg.to_string(index=False))

    # NO-longshot backtest: buy NO when YES price <= X
    print()
    for thr in [0.03, 0.05, 0.10, 0.15, 0.20]:
        sel = backtest_no_longshot(df, max_yes_price=thr)
        if sel is None or sel.empty:
            continue
        avg_ret = sel["return_pct"].mean()
        winrate = sel["yes_won"].mean()  # win = yes_won, so we LOSE; we want low win-rate
        print(f"Buy NO when YES<{thr:.2f}: n={len(sel):3d}  "
              f"NO win rate (yes_won=False) = {(1-winrate)*100:5.1f}%  "
              f"avg NO return = {avg_ret*100:+6.2f}% per trade  "
              f"total cumulative = {((1+sel['return_pct']).prod()-1)*100:+6.1f}%")

    # print 10 most costly trades (yes_won on low-price YES)
    losses = df[df["yes_won"]]
    if not losses.empty:
        low_yes_wins = losses.sort_values("pre_price_yes").head(5)
        print("\n5 worst NO-side 'surprises' (YES resolved despite low pre-price):")
        print(low_yes_wins[["question", "pre_price_yes"]].to_string(index=False))


if __name__ == "__main__":
    main()
