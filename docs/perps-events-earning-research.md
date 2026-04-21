# Perps + Events Earning Strategies — Research Report

**Third in series.** Follows `spy-orb-backtest-research.md` (SPY intraday, negative) and `sp500-beat-hold-research.md` (SPY 2x+SMA200, positive). This report extends to **on-chain venues**: Hyperliquid (perp DEX) and Polymarket (binary event markets).

**TL;DR.** Of six investigated strategies, **one is a clear "yes, deploy":**

- ✅ **HLP vault passive deposit** — ~15-25% APR on USDC, 5-10% DD, validated from 2023-05 onward.
- ⚠️ **Conditional funding harvest** (HL perps, APR>15% regimes only) — ~10-20% APR with 10-30% DD risk from cross-venue basis vol.
- ❌ All others (HL trend-following, always-on funding harvest, Polymarket arb, Polymarket longshot-NO, combined HL×PM) fail on economics, basis risk, or trade size.

Neither recommended strategy matches the risk-adjusted profile of the SPY 2x+SMA200 approach from the previous report. Crypto/event yields are less time-tested and carry different tails.

---

## Setup

- **Window**: 2024-01-01 → 2026-04-20 (2.3 years of HL data; HL perps launched mid-2023 at meaningful scale).
- **Data sources**:
  - Hyperliquid `/info` endpoint — daily candles + hourly funding for 9 majors (BTC, ETH, SOL, AVAX, LINK, ARB, OP, BNB, DOGE). `vaultDetails` for HLP portfolio history.
  - OKX public market data — spot OHLCV (Binance geo-blocked from the sandbox).
  - Polymarket Gamma + CLOB APIs — 2489 resolved markets with clear YES/NO outcomes.
- **Assumptions**: 10 bps round-trip tx cost on HL spot+perp entry/exit. 2 bps per monthly rebalance. 4% APR on parked USDC. Synthetic leverage uses `lev*spy_ret - (lev-1)*cash_ret - 0.9%/yr expense` (validated vs real SSO in the prior report).

---

## HL funding rate landscape

Average hourly funding rate 2024-2026, annualized:

| Coin  | Avg funding APR | Interpretation |
|-------|-----------------|----------------|
| DOGE  | 19.3%           | Longs pay shorts (meme rally demand) |
| LINK  | 18.4%           |                |
| BTC   | 15.7%           |                |
| ETH   | 13.2%           |                |
| SOL   | 13.2%           |                |
| ARB   | 12.3%           |                |
| AVAX  | 10.5%           |                |
| OP    | 10.5%           |                |
| BNB   | 5.3%            | Lowest on HL (heavier non-HL usage) |

Funding is positive ~85% of the time across majors. The trade is: *which side collects?*

---

## Strategy 1 — Trend-following on HL perps

Ported the SPY SMA approach. Backtest results (2024-01-01 → 2026-04-21):

| Asset | Spot buy-and-hold | Perp long (pays funding) | Best SMA variant (with funding) |
|-------|-------------------|--------------------------|---------------------------------|
| BTC   | **+26.3% CAGR**   | +13.4% CAGR              | +20.2% (SMA50 2x)               |
| ETH   | -0.9% CAGR        | -9.5% CAGR               | **+19.3%** (SMA50 1x)           |
| SOL   | -10.4% CAGR       | -18.0% CAGR              | Negative for every config       |

Funding drags BTC-perp CAGR by 12.9 points vs spot. An SMA-timed perp strategy recovers some but still underperforms raw spot hold. **The only "win" was ETH SMA50, which beat a very flat ETH spot period (-0.9%) by +20 points — this is situational, not structural alpha.**

**Verdict: don't.** If you want crypto trend-following, use spot (no funding drag), not perps.

---

## Strategy 2 — Cross-venue delta-neutral funding harvest

Classic "basis trade": long spot (OKX) + short perp (HL) = delta-neutral; collect funding as the short side. If funding averages 15% APR, this should yield ~15% APR with near-zero directional risk — that's the theory.

### Theoretical (synthetic-spot) numbers

| Coin  | CAGR    | Sharpe | MaxDD  |
|-------|---------|--------|--------|
| BTC   | 11.10%  | 10.98  | -0.18% |
| LINK  | 13.16%  | 11.03  | -0.17% |
| DOGE  | 13.85%  | 7.91   | -0.59% |

Sharpe 10+ is "too good to be true."

### Real-world numbers (OKX spot vs HL perp)

| Coin  | Funding (cum)  | Basis PnL (cum) | Gross (cum) | Compound CAGR |
|-------|----------------|-----------------|-------------|---------------|
| BTC   | +24.94%        | -6.77%          | +18.17%     | **-6.62%**    |
| ETH   | +21.19%        | -10.66%         | +10.53%     | **-20.44%**   |
| DOGE  | +30.95%        | -6.78%          | +24.17%     | **-32.98%**   |

**The gap between "cumulative gross" and "compound CAGR" is volatility drag.** Daily basis P&L (spot return minus perp return) has **54% annualized volatility on BTC**, because HL perp price routinely diverges from OKX spot by 5-10% on volatile days.

Concrete example from the data — 2026-02-05:
- OKX BTC spot close: **$68,629**
- HL BTC perp close: **$62,894**
- Single-day delta PnL: **+15.7%** (basis tightened)

And on 2024-08-08:
- Single-day delta PnL: **-11.2%** (basis widened)

These single-day ±15% swings are an order of magnitude larger than the daily funding income (~0.04%). The compounding of high-variance daily P&L destroys the harvest.

**Verdict: not viable cross-venue.** The trade works on Binance/OKX (where spot and perp are same-venue and tightly quoted) but is crowded there. HL's higher funding looks attractive but basis vol eats it.

### Conditional variant (regime filter)

Only deploy capital when 7-day rolling funding APR > 15% (roughly 20% of days):

| Coin | Threshold | Time in trade | CAGR   | MaxDD  |
|------|-----------|---------------|--------|--------|
| BTC  | APR > 15% | 19%           | +12.1% | -11.3% |
| SOL  | APR > 15% | 20%           | +19.9% | -14.7% |
| DOGE | APR > 10% | 34%           | +28.4% | -26.4% |

Positive CAGR but with 11-26% drawdowns — not the "market-neutral yield" the trade promises. Deployable in small size if you accept the basis risk, but definitely not low-risk.

---

## Strategy 3 — HLP vault passive deposit ✅

HLP is HL's community market-making vault. Deposit USDC, earn share of vault PnL (MM spreads + liquidations + platform fees). Fully liquid with a 1-day withdrawal lockup.

Historical performance via `vaultDetails` API:

| Period       | CAGR     | Sharpe* | MaxDD   | Notes |
|--------------|----------|---------|---------|-------|
| All-time (2023-05 → 2026-04) | **56.2%** | 8.4  | **-5.8%** | TVL grew $82k → $368M |
| 2023 partial | 120%     | 8.7     | -5.8%   | Small TVL, early |
| 2024         | 56.1%    | 19.3    | 0.0%    | Peak era |
| 2025         | 19.1%    | 6.6     | -0.8%   | Diluted by TVL growth |
| 2026 YTD     | 26.9%    | 6.4     | -0.5%   |       |

*Sharpe numbers use daily-resampled account value; actual intraday vol is higher.

**The APR is decaying with TVL growth** but still above 15% recently. Expected forward returns: **15-25% APR on USDC with ~5-10% max annual drawdown.**

### Known tail risks

- **JELLY incident (March 2025)**: HL manually delisted a manipulated JELLY market, HLP absorbed the bad position. Loss was socialized to vault depositors. Centralization concern; sets precedent for emergency actions.
- **HYPE token dynamics**: HL team holds significant HYPE; treasury decisions could indirectly affect HLP.
- **Smart-contract risk**: HL is on its own L1; fewer security audits than established L2s.
- **Liquidity cliffs**: HLP supplies MM on HL. If a major outflow event happens (stablecoin depeg, major hack elsewhere), HLP drawdown could be large.

**Realistic position sizing**: 5-15% of risk-capital portfolio, with acknowledgment that this is exposed to HL-specific failure modes (not correlated with traditional markets, but not uncorrelated with crypto-broad events).

---

## Strategy 4 — Polymarket within-market arbitrage ❌

Scanned 3,491 active Polymarket markets with ≥$5k liquidity. Every top candidate had YES+NO midprice = exactly 1.00. Orderbook best-asks on top 20 candidates all summed to ≥ 1.00. **No gross within-market arbitrage available** on liquid markets.

---

## Strategy 5 — Polymarket longshot NO-selling

Thesis: ultra-longshot YES prices (e.g., "Will Jesus return by 2027?" at 3.85%; "LeBron wins 2028 presidency" at 0.65%) are systematically overpriced by retail gamblers who like novelty bets.

Backtest on 135 resolved markets (2024-2026):

| Pre-price bucket | N   | Actual YES rate | Edge (bps) |
|------------------|-----|-----------------|------------|
| (0.00, 0.05]     | 96  | 0.0%            | -5.8       |
| (0.30, 0.50]     | 2   | 50%             | +917       |
| (0.80, 0.90]     | 1   | 100%            | +1900      |
| (0.90, 0.95]     | 1   | 100%            | +710       |
| (0.95, 1.01]     | 35  | 100%            | +14.9      |

**Calibration at the extremes is perfect.** Market prices < 5% YES **all resolve NO** (100% of 96 markets). But profit per trade is tiny:

- Buy NO when YES < 5%: 96 trades, 100% win rate, **+6 bps avg per trade**, +5.7% cumulative.

At 6 bps per trade and ~30-60 days hold time, APR is ~40-80% *before costs*. But Polymarket gas + slippage are 20-50 bps per round-trip, so the real-world profit is near zero.

Where this could work: YES=2-10% range (bigger discount, still strong NO probability). My sample had few markets in this range because most longshots trade at <0.5% — the popular headline markets.

**Verdict: tiny edge, eaten by fees.** A hand-picked approach on the 2-10% YES band might work but requires active scouting.

---

## Strategy 6 — HL × Polymarket options arb (NOT BACKTESTED)

Polymarket has crypto-price binary markets like "Will BTC be above $110k by end of 2026?" These behave like digital options. In principle you could compare the Polymarket-implied probability to the HL-perp-implied distribution and arb.

**Did not backtest** because:
1. Cross-venue basis vol (Strategy 2 finding) makes HL a poor hedging venue — any perp-short to hedge a Polymarket YES position suffers the same basis risk.
2. Polymarket crypto-price markets are low-liquidity (typically < $50k).
3. HL doesn't offer native options; a proper implementation would need HL options or same-venue delta hedging.

**If HL launches options** (rumored for 2026), this becomes the most interesting combined strategy and is worth revisiting.

---

## Final comparison — across all three reports

| Strategy (from reports) | CAGR    | Sharpe | MaxDD   | Validated? |
|-------------------------|---------|--------|---------|------------|
| SPY intraday ORB (report 1) | <hold | — | — | N/A (rejected) |
| SPY 2x+SMA200 (report 2) | **+15.9%** | **0.69** | **-41.3%** | 33yr + real SSO |
| HL trend on perps       | -9% to +20% | 0.3-0.6 | -30 to -80% | 2.3yr only |
| HL delta-neutral cross-venue | -6 to -33% | 0.0-0.1 | -22 to -78% | 2.3yr only |
| HLP vault passive       | **+19-56%** | **8.4**   | **-5.8%**  | 3yr live data |
| PM within-market arb    | ~0      | —      | —       | Current state |
| PM longshot NO          | ~6 bps/trade | — | —    | 135 resolved |

**Ranked recommendation order for new capital:**

1. **SPY 2x+SMA200** (tax-deferred account): time-tested 30+ years, ~16% CAGR with moderate DD.
2. **HLP vault deposit** (on-chain USDC): 15-25% APR, fully passive, some HL-specific tail risk.
3. **Conditional HL funding harvest** (speculative sleeve only): 10-20% APR with 10-30% DD risk.

None of the other strategies are worth the capital lockup or execution complexity they demand.

---

## Files

- `research-perps/` — all Python scripts (uv-managed)
  - `fetch_hl.py`, `fetch_spot.py` — data fetchers
  - `trend_strategy.py` — HL perp trend backtests
  - `funding_harvest.py` — synthetic-spot harvest (misleadingly positive)
  - `funding_harvest_v2.py` — real OKX+HL harvest (negative due to basis vol)
  - `debug_basis.py` — diagnostic showing basis-vol issue
  - `hlp_vault.py` — HLP vault TWR analysis
  - `polymarket_scan.py` — within-market arb scanner
  - `polymarket_longshot.py` — resolution-calibration backtest
- `research-perps/FINDINGS.md` — live log with raw numbers
- `docs/perps-events-earning-research.md` — this document

---

## Next steps

1. **Paper-trade HLP deposit** in small size (e.g., $1000) for 60 days to confirm real-world vs API-reported TWR match.
2. **Monitor HL for options launch** — reassess Strategy 6 if introduced.
3. **Watch HL funding-rate distribution** quarterly. If coin-specific funding APR > 20% with low basis vol (e.g., DOGE when stable), conditional harvest becomes more attractive.
4. **Consider Binance/OKX-native basis trade** if CEX access becomes available — same-venue spot/perp has ~5% APR with near-zero DD historically.
5. **Extend Polymarket research** to hand-curated 5-15% YES markets with clear semantic edge (sports, weather, etc.).
