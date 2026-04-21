"""Polymarket arbitrage / mispricing scanner.

Two strategies to evaluate:
1. WITHIN-MARKET ARB: YES + NO prices should sum to 1.00. When they don't
   (usually because of stale orderbook on one side), buy both for < $1 and
   collect $1 at resolution.

2. HISTORICAL RESOLUTION: fetch resolved markets, compare final market price
   (days before resolution) vs actual outcome. If markets are systematically
   mispriced (e.g. favorites underpriced), there's an edge.

APIs used:
- Gamma API: https://gamma-api.polymarket.com/markets  (metadata + bestBid/bestAsk)
- CLOB API: https://clob.polymarket.com/prices-history  (historical price series)
- Data API: https://data-api.polymarket.com/trades       (historical trades)
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pandas as pd
import requests

DATA = Path(__file__).parent / "data"
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
PMAPI = "https://data-api.polymarket.com"


def fetch_markets(closed: bool = False, limit: int = 500, offset: int = 0,
                  min_liquidity: float = 1000.0) -> list[dict]:
    """Fetch active or closed markets, paginated."""
    all_markets = []
    while True:
        r = requests.get(f"{GAMMA}/markets",
                         params={"closed": str(closed).lower(), "limit": limit,
                                 "offset": offset, "order": "volumeNum", "ascending": "false"},
                         timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        all_markets.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
        time.sleep(0.3)
        if offset >= 4000:
            break
    # filter by liquidity
    return [m for m in all_markets if float(m.get("liquidity") or 0) >= min_liquidity]


def scan_within_market_arb(markets: list[dict]) -> pd.DataFrame:
    """For each market, compute YES+NO offer prices and look for arb."""
    rows = []
    for m in markets:
        # outcomePrices is a JSON-encoded list of strings like "[\"0.67\",\"0.33\"]"
        try:
            prices = json.loads(m.get("outcomePrices") or "[]")
            if len(prices) != 2:
                continue
            yes_price = float(prices[0])
            no_price = float(prices[1])
        except Exception:
            continue
        best_bid = m.get("bestBid")
        best_ask = m.get("bestAsk")
        total = yes_price + no_price
        arb_gap = 1.0 - total  # positive = arbitrage (buy both for < 1)
        rows.append({
            "question": (m.get("question") or "")[:60],
            "slug": m.get("slug"),
            "liquidity": float(m.get("liquidity") or 0),
            "volume": float(m.get("volume") or 0),
            "yes_mid": yes_price,
            "no_mid": no_price,
            "sum": total,
            "arb_gap_bps": arb_gap * 10000,
            "end_date": m.get("endDate"),
            "active": m.get("active"),
            "conditionId": m.get("conditionId"),
        })
    return pd.DataFrame(rows).sort_values("arb_gap_bps", ascending=False)


def scan_orderbook_arb(conditionIds: list[str]) -> list[dict]:
    """For top candidates, pull the actual orderbook and compute true arb with best ask."""
    rows = []
    for cid in conditionIds:
        # Fetch token IDs via the gamma market
        r = requests.get(f"{GAMMA}/markets", params={"condition_ids": cid}, timeout=15)
        if r.status_code != 200:
            continue
        market = r.json()
        if not market:
            continue
        m = market[0]
        try:
            tokens = json.loads(m.get("clobTokenIds") or "[]")
        except Exception:
            continue
        if len(tokens) != 2:
            continue
        # fetch book for each token
        books = []
        for tid in tokens:
            try:
                rr = requests.get(f"{CLOB}/book", params={"token_id": tid}, timeout=10)
                if rr.status_code != 200:
                    continue
                books.append(rr.json())
            except Exception:
                continue
        if len(books) != 2:
            continue
        # best ask = lowest sell price on each
        best_asks = []
        for b in books:
            asks = b.get("asks") or []
            if not asks:
                best_asks.append(None)
                continue
            best_asks.append(min(float(a["price"]) for a in asks))
        if any(a is None for a in best_asks):
            continue
        total_ask = best_asks[0] + best_asks[1]
        if total_ask >= 1.0:
            continue
        rows.append({
            "question": m.get("question"),
            "yes_ask": best_asks[0],
            "no_ask": best_asks[1],
            "total_ask": total_ask,
            "arb_profit_bps": (1.0 - total_ask) * 10000,
            "liquidity": float(m.get("liquidity") or 0),
            "volume": float(m.get("volume") or 0),
        })
    return rows


def fetch_price_history(token_id: str, fidelity: int = 60) -> pd.DataFrame | None:
    """Fidelity is in minutes between points. Returns timeseries of mid price."""
    r = requests.get(f"{CLOB}/prices-history",
                     params={"market": token_id, "interval": "max", "fidelity": fidelity},
                     timeout=30)
    if r.status_code != 200:
        return None
    data = r.json()
    hist = data.get("history", [])
    if not hist:
        return None
    df = pd.DataFrame(hist)
    df["time"] = pd.to_datetime(df["t"], unit="s", utc=True).dt.tz_localize(None)
    df = df.set_index("time").sort_index()
    df = df.rename(columns={"p": "price"})
    return df[["price"]]


def resolution_efficiency(resolved_markets: list[dict], days_before: int = 7) -> pd.DataFrame:
    """For resolved markets, compare implied probability N days before resolution vs outcome."""
    rows = []
    for m in resolved_markets[:80]:  # cap to avoid rate limits
        try:
            tokens = json.loads(m.get("clobTokenIds") or "[]")
            outcomes = json.loads(m.get("outcomes") or "[]")
        except Exception:
            continue
        if len(tokens) != 2 or len(outcomes) != 2:
            continue
        # fetch YES price history
        try:
            hist = fetch_price_history(tokens[0], fidelity=60)
        except Exception:
            continue
        if hist is None or len(hist) == 0:
            continue
        end_date = pd.to_datetime(m.get("endDate"))
        if pd.isna(end_date):
            continue
        end_date = end_date.tz_localize(None) if end_date.tzinfo else end_date
        cutoff = end_date - pd.Timedelta(days=days_before)
        pre = hist.loc[hist.index <= cutoff]
        if pre.empty:
            continue
        pre_price = pre["price"].iloc[-1]
        # Winning outcome per gamma: "Yes" or "No"; outcomePrices final = winner = 1
        try:
            final_prices = json.loads(m.get("outcomePrices") or "[]")
        except Exception:
            continue
        if len(final_prices) != 2:
            continue
        yes_won = float(final_prices[0]) > 0.99
        rows.append({
            "question": (m.get("question") or "")[:60],
            "pre_price_yes": pre_price,
            "yes_won": yes_won,
            "volume": float(m.get("volume") or 0),
            "liquidity": float(m.get("liquidity") or 0),
            "end_date": m.get("endDate"),
        })
        time.sleep(0.15)
    return pd.DataFrame(rows)


def main():
    print("Fetching active markets with liquidity >= $5k...")
    markets = fetch_markets(closed=False, min_liquidity=5000)
    print(f"  Got {len(markets)} active markets")

    # Within-market arb using gamma's bestBid/bestAsk
    arb = scan_within_market_arb(markets)
    print(f"\nTop 15 'gap' candidates (YES+NO < 1):")
    print(arb.head(15)[["question", "liquidity", "yes_mid", "no_mid", "sum", "arb_gap_bps"]].to_string(index=False))

    # Verify with actual orderbooks for top candidates
    top_cids = arb.head(20)["conditionId"].dropna().tolist()
    print(f"\nVerifying orderbook arb for top {len(top_cids)} candidates...")
    book_arbs = scan_orderbook_arb(top_cids)
    if book_arbs:
        bdf = pd.DataFrame(book_arbs).sort_values("arb_profit_bps", ascending=False)
        print("\nActual orderbook-level arbitrages (buy both YES & NO asks for < $1):")
        print(bdf[["question", "yes_ask", "no_ask", "total_ask", "arb_profit_bps", "liquidity"]].head(10).to_string(index=False))
    else:
        print("  No orderbook arbs found (all spreads filled to 1.00 or better)")

    # Resolution efficiency on closed markets
    print("\n\nFetching recently resolved markets...")
    closed = fetch_markets(closed=True, min_liquidity=5000)
    print(f"  {len(closed)} resolved markets with >= $5k liquidity")
    eff = resolution_efficiency(closed[:100], days_before=7)
    if len(eff) > 0:
        print(f"\nOf {len(eff)} resolved markets: 7 days before resolution...")
        # bucket by pre-price
        bins = [0, 0.2, 0.4, 0.6, 0.8, 1.01]
        eff["bucket"] = pd.cut(eff["pre_price_yes"], bins=bins)
        agg = eff.groupby("bucket", observed=True).agg(
            n=("yes_won", "size"),
            mean_pre_price=("pre_price_yes", "mean"),
            actual_win_rate=("yes_won", "mean"),
        ).reset_index()
        agg["bias_pct"] = (agg["actual_win_rate"] - agg["mean_pre_price"]) * 100
        print("\nCalibration (does market price match actual win rate?):")
        print(agg.to_string(index=False))
        print(f"\nOverall avg pre-price: {eff['pre_price_yes'].mean():.3f}  actual YES rate: {eff['yes_won'].mean():.3f}")


if __name__ == "__main__":
    main()
