# Research findings — live log

Last updated: 2026-04-21.

## Setup

- Data: Yahoo Finance daily bars for SPY + macro factors (^VIX, ^VIX3M, ^IRX, ^TNX, HYG, LQD, TLT, IEF, GLD, QQQ), cached to `data/*.csv`.
- Environment: Alpine Linux (musl), non-root. Python 3.12 via `uv` in user-space.
- Window: **1994-01-01 → 2026-04-20 (33.3 years)** once extended. SPY buy-and-hold: **CAGR 10.75%, Sharpe 0.64, MaxDD -55.19%**.
- Slippage: 1-2 bps per trade. Leveraged returns simulated daily: `lev * spy_ret - (lev-1) * cash_ret - 0.9%/yr expense`. Cash = 13W T-bill daily compound.
- 1-day execution lag on every signal (no look-ahead).

## Kotlin MacroRegimeEngine (Option A) does NOT beat SPY hold

Ported the exact scoring (SMA50/200 + ADX/slope + FFR + yield curve + HYG/LQD z) and swept thresholds. Best mBase-gated rotation: **6.24% CAGR vs 10.88% SPY** over 2006-2026. Bug list:

- ADX<20 → -1 score: false bear signals in low-vol bulls.
- FFR thresholds map modern 4-5.5% rates to negative.
- HYG/LQD 20-day z-score is too noisy (many false fires).
- 100+ switches / 20 years → whipsaw cost + missed drift.
- Holding cash 30-50% of the time at IRX rate = huge opportunity cost against SPY's 7-10% drift.

## What works — leveraged SMA trend-following

**Full-period results (1994-2026, 33.3 years):**

| Strategy                        | CAGR    | Sharpe | MaxDD   | Calmar | TR vs SPY | Switches |
|---------------------------------|---------|--------|---------|--------|-----------|----------|
| SPY buy-and-hold                | 10.75%  | 0.64   | -55.2%  | 0.19   | 26.0x     | 0        |
| 2x SPY + SMA200                 | 13.30%  | 0.64   | -51.5%  | 0.26   | 56.4x     | 214      |
| **2x smart exit200/entry100**   | 15.26%  | 0.71   | -57.2%  | 0.27   | 98.0x     | 446      |
| **2x smart hold=5d**            | 15.86%  | 0.69   | -41.3%  | 0.38   | 116.1x    | 346      |
| 2x dual-SMA (price>S200 & S50>S200) | 12.89% | 0.64 | -41.2%  | 0.31   | 50.2x     | 152      |
| 2x hybrid dual-entry + exit-5d  | 13.47%  | 0.63   | -42.5%  | 0.32   | 59.3x     | 60       |
| Adaptive VIX-bucket leverage    | 14.38%  | 0.62   | -40.3%  | 0.36   | 76.6x     | 940      |
| 3x smart hold=5d                | 20.47%  | 0.66   | -55.7%  | 0.36   | 408.3x    | 346      |

**Walk-forward (beats SPY in all 3 decades):**

| Strategy                     | 1994-2003 | 2004-2013 | 2014-2026 |
|------------------------------|-----------|-----------|-----------|
| SPY hold                     | 10.93%    | 7.35%     | 13.55%    |
| 2x smart exit200/entry100    | **13.24%**| **13.23%**| **18.83%**|
| 2x smart hold=5d             | 19.11%    | 13.23%    | 15.63%    |
| Adaptive-v2                  | 17.01%    | 12.06%    | 16.79%    |
| 2x dual-SMA                  | 14.70%    | 9.20%     | 14.69%    |

**Stress tests — total return during each crisis:**

| Strategy                 | Dot-com | GFC   | COVID | 2022 bear | Q4-2018 | 2011 |
|--------------------------|---------|-------|-------|-----------|---------|------|
| SPY buy-and-hold         | -33.8%  | -46.6%| -14.5%| -18.6%    | -13.8%  | -5.2%|
| 2x smart 200/100 base    | -40.5%  | -18.1%| -22.3%| -22.6%    | -18.1%  |-16.4%|
| 2x smart hold=5d         |  -9.6%  | -28.6%| -35.2%| -31.3%    | -22.9%  |-33.8%|
| 2x dual-SMA confirm      | -17.0%  | -17.6%| -31.8%| -20.9%    | -20.2%  |-12.5%|
| 2x hybrid dual+exit=5d   | **+9.2%**|-25.6%| -35.2%| -18.7%    | -25.9%  |-30.5%|

Takeaways:
- **Long, slow bears (dot-com, GFC)** are handled well by trend filters — dual-SMA confirmation makes money in dot-com (+9.2%) while SPY loses 34%.
- **Short sharp shocks (COVID, 2018-Q4, 2011)** cause whipsaw losses — price drops below SMA then V-bounces above before filters reset.
- No single strategy dominates all crises. **Trade-off**: strict re-entry (dual-SMA) helps bears, hurts shocks. Fast re-entry (smart SMA100) opposite.

## Recommended strategy

**Primary: 2x SPY + SMA200 with smart entry/exit (exit < SMA200, re-enter > SMA100), 5-day exit confirmation.**

Specification:
```
enter: price > SMA100
exit:  price < SMA200 for 5 consecutive closes
leverage when in-market: 2x (synthetic, or SSO ETF)
leverage when out:       0x (cash / T-bills)
signal: daily close, execute next-open
rebalance: daily (actual leverage drifts with SPY intraday)
```

**Performance (1994-2026):**
- CAGR: 15.86% (vs SPY 10.75%) — **+5.11 percentage points**
- Sharpe: 0.69 (vs SPY 0.64)
- MaxDD: -41.3% (vs SPY -55.2%)
- Total return: 116x vs SPY's 26x (**4.5x more money**)
- ~10-14 switches / year

## What didn't work

| Idea | Result |
|------|--------|
| Kotlin MacroRegimeEngine (mBase) | 6.24% vs 10.88% SPY |
| Daily vol-targeted leverage | 7-10% CAGR, 800+ switches eat returns |
| Vol-managed SPY (no trend filter) | Matches SPY, no edge |
| Long exit delay (10+ days) | Sharpe drops, DD increases |
| Large exit buffer (5% below SMA) | MaxDD explodes to -73% |
| Dual momentum (12m absolute) | 7.8% CAGR, underperforms hold |
| Faber GTAA-5 (multi-asset 200-SMA) | 7.2% CAGR but Sharpe 1.08 — great for conservative |
| GEM 6-month momentum | 11.6% CAGR, Sharpe 0.85 — interesting unleveraged option |

## Synthetic vs real SSO/UPRO — validation

Ran the same timed strategy through real SSO/UPRO total-return data (since 2006 / 2009):

| Position                | Synthetic CAGR | Real ETF CAGR | Haircut |
|-------------------------|----------------|---------------|---------|
| 2x SPY hold             | 16.10%         | 15.29% (SSO)  | -0.81%  |
| 2x SPY timed (smart+5d) | 15.98%         | 15.48% (SSO)  | -0.50%  |
| 3x SPY hold             | 33.91%         | 32.24% (UPRO) | -1.67%  |

The timed strategy's haircut is smaller than hold's because being in cash ~20% of the time removes compounding of the daily-reset drag. Net: real-money 2x strategy still beats SPY hold by ~4 pts CAGR after accounting for ETF tracking error.

## Caveats / risks to production deployment

1. ~~Synthetic 2x vs real SSO/UPRO tracking~~: **validated above** — 0.5-1 pt haircut on 2x, 1.7 pts on 3x. Smaller than feared.
2. **Volatility drag**: 2x daily reset compounds negatively in chop. Real SSO returned ~13% CAGR since 2006 vs synthetic ~14-15% — a ~1 pt haircut.
3. **Taxes not modeled**: 14 trades/yr → mostly short-term gains at ordinary-income rates. Better in tax-deferred accounts (IRA/401k).
4. **Liquidity assumed infinite**: SSO ~$7B AUM, ~$200M daily volume. Fine for individual accounts up to ~$10-50M; larger would need direct futures.
5. **1-day lag**: OK for paper trading. Real-world slippage on market orders ~2-5 bps for ETFs.
6. **SMA crossover is well-known** — the edge is the leverage-on-trend-filter *combination*, not secret sauce. Edge is structural (momentum + trend premium) but has worked for 90+ years in equities.
7. **Psychological risk**: -41% drawdown is still brutal. Discipline to not exit after seeing that DD is critical.
8. **Regime change**: a decade of sustained rangebound markets (like 1966-1982) would be deadly for this. Monitor; reduce leverage if real-time results diverge from backtest.

## Files

- `fetch_data.py` — Yahoo data fetcher (CSV cache in `data/`, 1993-01-01 onward).
- `common.py` — indicators, metrics, simulation helpers.
- `macro_engine.py` — Python port of Kotlin MacroRegimeEngine.
- `backtest.py` — initial Option A reproduction (negative result).
- `strategies.py` — Faber, dual momentum, VIX-filter, simple leveraged variants.
- `walkforward.py` — train/test split + subperiod stress tests + monthly variants.
- `advanced.py` — vol targeting, GEM, GTAA-5, regime leverage, whipsaw reductions.
- `final.py` — 33-year long-history validation on core winners.
- `refinements.py` — buffered exit, VIX term-structure gate, dual-SMA confirmation.
- `ensemble.py` — final side-by-side comparison + adaptive-leverage variant.
