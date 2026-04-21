# Perps + Events earning strategies — research log

Last updated: 2026-04-21. Branch: `feature/trader-perps-events`.

## Scope

Investigate earning strategies on **Hyperliquid** (on-chain perp DEX) and **Polymarket** (binary event markets), following the format of the SPY research. All public data; no exchange accounts used.

Window: 2024-01-01 → 2026-04-20 (2.3 years of daily data from HL; more from Polymarket metadata).

## Data

- **Hyperliquid**: public `/info` endpoint. Fetched 1d candles + hourly funding for BTC, ETH, SOL, AVAX, LINK, ARB, OP, BNB, DOGE. HLP vault portfolio history.
- **OKX spot**: `/api/v5/market/history-candles`. Daily OHLCV for the same coins (needed because HL has no BTC/ETH spot market and Binance is geo-blocked).
- **Polymarket**: Gamma API markets + CLOB prices-history. 2489 archived/resolved markets with clear YES/NO outcomes.

## Key facts

- HL average funding rates 2024-2026 (annualized): BTC 15.7%, DOGE 19.3%, LINK 18.4%, ETH 13.2%, SOL 13.2%, BNB 5.3%. **Longs pay shorts ~85% of the time** on majors.
- HLP TVL: ~$371M. Available to anyone as a vault deposit. Historical: 20-56% APR with ~6% max drawdown.
- Polymarket ~3500 active markets with ≥$5k liquidity. YES+NO always sums to ~1.00 (no gross arb on liquid markets).

## Strategy 1 — Trend-following on HL perps (DOES NOT WORK)

Ported the SPY 2x+SMA200 approach to HL perps. **The funding cost destroys the edge**:

| Asset | Spot buy-hold | Perp long (w/funding) | Best SMA-timed perp |
|-------|---------------|------------------------|---------------------|
| BTC   | +26.26% CAGR  | +13.40% CAGR           | +20.15% (SMA50, 2x) |
| ETH   | -0.87% CAGR   | -9.45% CAGR            | +19.25% (SMA50, 1x) |
| SOL   | -10.41% CAGR  | -18.03% CAGR           | all variants negative |

Funding drag on a long perp = ~13 pts CAGR on BTC. Since the strategy is long-biased, funding payment cumulates to dominate returns. The best trend variants on ETH *did* beat ETH spot hold (+19.25% vs -0.87% = +20 pts alpha), but this is because 2024-26 was a rangebound ETH period, not a sustainable edge.

**Conclusion:** leveraged trend-following on crypto perps with positive-carry funding is structurally disadvantaged vs the equivalent spot strategy. If you want crypto trend-following, use spot or futures (no funding drag).

## Strategy 2 — Delta-neutral funding harvest (NOT VIABLE CROSS-VENUE)

Classic "basis trade": long spot + short perp = delta-neutral; collect funding rate as income.

On paper with SYNTHETIC spot (spot reconstructed from perp/premium):
- BTC: 11.10% CAGR, Sharpe 10.98, MaxDD -0.18%
- LINK: 13.16% CAGR, Sharpe 11.03, MaxDD -0.17%
- Equal-weight basket: 9.38% CAGR, Sharpe 9.35, MaxDD -0.29%

With **REAL OKX spot vs HL perp**:
- BTC: funding earned +24.94%, basis P&L -6.77%, **but daily vol drag makes compound CAGR -6.62%**.
- ETH: funding +21.19%, basis -10.66%, compound CAGR -20.44%.
- All 9 coins negative CAGR.

**Why it breaks:** HL is small enough that its perp price regularly diverges from OKX spot by 5-10% on volatile days. Example — 2026-02-05: OKX BTC spot $68,629 vs HL perp $62,894 — **9% apart in a single day**. Annualized daily basis vol is ~54% on BTC. Funding income (~12% APR at best) is dwarfed by basis variance drag when cross-venue.

**Conclusion:** delta-neutral funding harvest on HL perps requires SAME-VENUE spot, which HL doesn't offer for BTC/ETH. The trade exists on Binance/OKX (where both spot and perp trade) but is crowded there. HL's higher funding rates look appealing but basis vol makes them unreachable without additional hedging infrastructure.

### Conditional variant (minimum APR threshold)

A partial exception: only deploy capital when 7-day rolling funding APR > 15% (roughly 20% of days). This concentrates exposure in high-funding regimes and reduces average time-in-market:

| Coin | APR threshold | Time in trade | CAGR | MaxDD |
|------|---------------|---------------|------|-------|
| BTC  | >15%          | 19%           | +12.10% | -11.30% |
| SOL  | >15%          | 20%           | +19.87% | -14.72% |
| DOGE | >10%          | 34%           | +28.36% | -26.44% |

These look positive, but basis-risk drawdowns are still 10-30% (not "market-neutral"). Better than always-on, but not the risk-free yield the naive backtest suggested.

## Strategy 3 — HLP vault passive deposit (REAL, DECAYING)

HLP is HL's community market-making vault. Any wallet can deposit USDC; returns reflect vault PnL after HL platform fee share.

Historical TWR (from `vaultDetails` API):

| Period     | CAGR     | Sharpe | MaxDD  |
|------------|----------|--------|--------|
| All-time (2023-05 → 2026-04) | 56.23% | 8.36   | -5.77% |
| 2023 (partial) | 119.75% | 8.72 | -5.77% |
| 2024           | 56.14%  | 19.33 | 0.00%  |
| 2025           | 19.14%  | 6.65  | -0.80% |
| 2026 YTD       | 26.92%  | 6.37  | -0.50% |

**This is a real edge.** The vault earns from MM spreads + liquidations + platform fees. TVL has grown from $82k → $368M, diluting per-dollar yield. Recent APR is trending toward ~20%.

**Tail risks:**
- JELLY incident (March 2025): HL manually delisted a manipulated market, absorbing the loss out of HLP. Centralization concern.
- Any similar socialization event would hit HLP first.
- Sharpe 8+ on daily-resample data hides intraday vol of MM position P&L.
- HYPE token liquidity, team treasury decisions.

**Realistic expected forward return**: 15-25% APR on USDC, with 5-10% max annual drawdown risk.

## Strategy 4 — Polymarket arbitrage (TOO TIGHT)

Scanned 3491 active markets with ≥$5k liquidity for within-market YES+NO ≠ 1.00 gaps. Result: **top 20 candidates all sum to exactly 1.00 at mid, and orderbook best-ask totals ≥ 1.00 for every one.** The MM layer on Polymarket's main markets keeps this arb closed.

## Strategy 5 — Polymarket long-tail YES-sell (MARGINAL)

Thesis: retail gamblers overpay for longshot YES (e.g. "Will Jesus return by 2027?" at 3.85%). Systematically buying NO on YES<5% markets should pay at resolution.

Tested on 135 resolved markets (2024-2026):

| Pre-price bucket | N   | Actual YES rate | Calibration |
|------------------|-----|-----------------|-------------|
| (0.00, 0.05]     | 96  | 0.0%            | Perfectly calibrated |
| (0.30, 0.50]     | 2   | 50%             | (small n)   |
| (0.80, 0.90]     | 1   | 100%            | (small n)   |
| (0.90, 0.95]     | 1   | 100%            | (small n)   |
| (0.95, 1.01]     | 35  | 100%            | Perfectly calibrated |

**NO-longshot backtest**: buy NO on every YES<5% market, hold to resolution. 96 trades, **100% win rate, avg profit +0.06% per trade, cumulative +5.7%** over the sample.

**Profit per trade is too small** (6 bps) to overcome gas/slippage (~20-50 bps on Polymarket). The "free money" is free because nobody bothers for that edge. Markets in the 2-10% YES range would have better economics but my sample had few of those (most longshots trade at 0.01-0.5%).

## Strategy 6 — HL × Polymarket combined (NOT PURSUED)

Concept: Polymarket has crypto-price markets like "Will BTC be above $X by Y?" — these are binary option-like structures. In principle, one could arb them vs HL perp-implied vol (use HL perps to hedge; the Polymarket side prices the implied option).

Did not backtest because:
1. Cross-venue basis volatility (Strategy 2 finding) makes HL a poor hedging venue anyway.
2. These crypto-price markets on PM are low-liquidity (typically <$50k).
3. Realistic edge requires same-venue listed options (not available on HL yet).

If HL adds BTC/ETH options, this strategy becomes attractive.

## Final recommendation

| Strategy                               | Realistic edge | Deploy? |
|----------------------------------------|----------------|---------|
| HL trend-following on perps            | Negative (funding drag) | No |
| Cross-venue delta-neutral (OKX+HL)     | Negative (basis vol) | No |
| Conditional funding harvest (>15% APR) | ~10-20% APR with ~15% DD risk | Maybe, small size |
| **HLP vault passive deposit**          | **~15-25% APR, 5-10% DD** | **Yes — primary allocation** |
| Polymarket within-market arb           | ~0 (tight market) | No |
| Polymarket longshot NO-selling         | ~6 bps/trade (too small) | No |
| HL × Polymarket options arb            | Unclear (not tested) | Revisit when HL adds options |

**Primary recommendation for immediate deployment: HLP vault.** It's a passive USDC deposit returning 15-25% APR with demonstrated low drawdown and is the one clear, real, historically validated on-chain yield source found in this investigation.

**Secondary (for more active capital)**: conditional funding harvest on top-3 high-APR HL coins, but only deploy during APR > 15% regimes. Expected 10-20% APR with significant basis-vol drawdown risk.

Neither approach beats the SPY 2x+SMA200 strategy from the prior research (15.86% CAGR, -41% MaxDD, validated 33 years) in risk-adjusted terms. Crypto/event yields are much less time-tested.

## Files

- `fetch_hl.py` — HL `/info` endpoint wrapper (candles + funding)
- `fetch_spot.py` — OKX spot daily OHLCV
- `common.py` — shared metrics + data loading
- `trend_strategy.py` — port of SPY SMA approach to HL perps (negative result)
- `funding_harvest.py` — synthetic-spot version (misleadingly optimistic)
- `funding_harvest_v2.py` — real OKX spot vs HL perp (realistic, negative)
- `debug_basis.py` — diagnostic showing why v2 is negative (basis vol)
- `hlp_vault.py` — HLP vault TWR analysis
- `polymarket_scan.py` — within-market arb scanner
- `polymarket_longshot.py` — resolved-market calibration + NO-longshot backtest

Data cached to `data/*.csv`, `data/hlp_vault.json` (gitignored).
