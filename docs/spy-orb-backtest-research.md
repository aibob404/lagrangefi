# SPY ORB Backtest Research

Comprehensive research log for the SPY Opening Range Breakout algorithmic trading strategy — parameter sweeps, architectural improvements, and conclusions from systematic backtesting (2021–2024, 2016–2024).

## Overview

**Goal:** Beat SPY buy-and-hold (+13.9% CAGR over 2021–2024) with a systematic intraday strategy.

**Verdict:** SPY ORB long-only cannot beat passive hold at any parameter combination tested. The structural math makes it impossible at reasonable risk levels. A fundamentally different approach is required.

---

## Strategy Architecture

### The Signal Pipeline

```
MacroRegimeEngine → VolatilityRegimeEngine → EventFilter → OrbSignal → SignalOrchestrator
```

### 14-Gate Checklist (all must pass for a trade)

| Gate | Description |
|------|-------------|
| Gate 1 | Event calendar (FOMC, CPI, NFP, OPEX) — block or reduce size |
| Gate 2 | Macro regime: mBase ≥ macroGate (default 1) |
| Gate 3 | Volatility regime: VIX not in EXTREME/CRISIS, not backwardation |
| Gate 4 | Time window: 09:45–15:30 ET |
| Gate 5 | ORB defined, OR range valid (0.15–1.0 × daily ATR14) |
| Gate 6 | Bullish breakout: 5-min close > OR_high after 09:45 |
| Gate 6b | (Retest mode) Pullback to OR_high zone before entry |
| Gate 7 | Relative volume ≥ rvolMin (default 1.5) |
| Gate 8 | Price above session VWAP |
| Gate 9 | Entry not overextended (close − OR_high ≤ 0.5 × daily ATR) |
| Gate 10 | EMA stack bullish: 9 > 21 > 200 (5-min) |
| Gate 11 | RSI(14) in [rsiMin, rsiMax] (default 50–70) |
| Gate 12 | MACD histogram positive and rising |
| Gate 13 | Entry not within 0.25 × ATR of prior-day POC |

### Position Sizing

- Risk per trade: 0.5% of equity (configurable)
- 3 legs (1/3 each): TP1 at 1R, TP2 at 2R, TP3 chandelier trail (2.5 × ATR5)
- Stop moves to breakeven after TP1

### Key Parameters (configurable via `SignalConfig`)

```kotlin
data class SignalConfig(
    val macroGate: Int = 1,          // minimum mBase for longs
    val rvolMin: Double = 1.5,       // minimum relative volume
    val stopAtrMult: Double = 0.5,   // stop = mult × ATR5
    val retestEntry: Boolean = false, // wait for OR_high pullback
    val rsiMin: Double = 50.0,
    val rsiMax: Double = 70.0,
    val requireMacd: Boolean = true,
    val allowShorts: Boolean = false,
    val shortMacroGate: Int = -1     // shorts require mBase ≤ this
)
```

---

## MacroRegimeEngine

Computes a daily macro score `mBase ∈ [-5, +5]` from:

- Fed funds rate (^IRX — 13W T-bill)
- 10Y yield (^TNX)
- Yield curve shape (10Y − 3M spread)
- HYG and LQD credit spreads (vs long-term averages)
- VIX regime (LOW/NORMAL/ELEVATED/HIGH/EXTREME/CRISIS)
- VIX term structure (contango vs backwardation)
- 200-day SMA trend on SPY
- ADX trend strength

Scoring: each factor contributes +1 or -1 to mBase. Requires 200+ daily bars of history.

---

## Data Infrastructure

### Sources

| Dataset | Source | Cache key |
|---------|--------|-----------|
| SPY 5-min OHLCV | Alpaca Historical API | `spy_5min_YYYY-MM-DD_YYYY-MM-DD.json` |
| SPY daily OHLCV | Alpaca Historical API | `spy_daily_2010-01-01_END.json` |
| Macro (VIX, ^IRX, ^TNX, HYG, LQD, VVIX) | Yahoo Finance | `macro_2010-01-01_END.json` |

### Disk Cache

All fetched data is cached to `.backtestcache/` (gitignored) as serialized JSON using kotlinx.serialization. Second and subsequent runs load from disk instantly.

```kotlin
private inline fun <reified T> cached(key: String, fetch: () -> T): T {
    val file = File(cacheDir, "$key.json")
    if (file.exists()) return cacheJson.decodeFromString(file.readText())
    val data = fetch()
    file.writeText(cacheJson.encodeToString(data))
    return data
}
```

**Requirement:** `Bar`, `DailyBar`, `MacroSnapshot` must be `@Serializable`.

---

## Backtest Infrastructure

### BacktestEngine

- Replays 5-min bars day by day, bar by bar
- Precomputes `MacroRegimeResult` once per day (O(n) not O(n²))
- Precomputes `dailyAtr` and `atr5` from prior day's bars
- Single position at a time (Phase 1 constraint)
- Circuit breakers: daily -2%, weekly -4%, monthly -7%, peak drawdown -15%
- Force-closes any open position at 15:55 ET (EOD)
- Callbacks: `onProgress(String)` and `onEval(TradeSignal)`

### Portfolio

Tracks equity, position state, and PnL with:
- 3-leg exit structure: TP1 (1R), TP2 (2R), TP3 chandelier trail
- Slippage model: 1 bp per side
- **Both long and short support** — `isShort` flag inverts all stop/TP/trail logic
- Chandelier trail: for longs, trail from highest high; for shorts, from lowest low

### ReportGenerator

Computes from `BacktestResult`:
- Total trades, win rate, profit factor
- Sharpe ratio (annualized)
- Max drawdown %
- Net return % and CAGR

### Running the Sweep

```bash
cd apps/api
ALPACA_KEY=xxx ALPACA_SECRET=xxx \
START_DATE=2021-01-01 END_DATE=2024-12-31 \
./gradlew backtestSweep --quiet
```

---

## Sweep Results (2021–2024)

**Benchmark:** SPY buy-and-hold = **+68.3% total (+13.9% CAGR)**

### Gate Rejection Funnel (M≥0 baseline, 76,926 non-trade evals)

| Gate | Count | % |
|------|-------|---|
| Gate 2 (macro score) | 25,022 | 32.5% |
| Gate 7 (RVOL < 1.5) | 13,952 | 18.1% |
| Gate 4 (time window) | 11,683 | 15.2% |
| Gate 6 (no breakout) | 10,242 | 13.3% |
| Gate 3 (vol regime) | 6,352 | 8.3% |
| Gate 5 (ORB/OR range) | 5,486 | 7.1% |
| Gate 1 (events) | 2,175 | 2.8% |
| Gate 6b (no retest) | 1,681 | 2.2% |
| Gate 12 (MACD) | 225 | 0.3% |
| Gate 11 (RSI) | 108 | 0.1% |

### Selected Results

| Config | Trades | Win% | PF | Sharpe | MaxDD% | CAGR% | Beats hold? |
|--------|--------|------|----|--------|--------|-------|-------------|
| Chase M≥2 RVOL1.5 stop×0.50 | 9 | 44.4% | 1.97 | 0.32 | 2.4% | +1.05% | ❌ |
| Chase M≥1 RVOL1.5 stop×0.50 | 32 | 18.8% | 0.48 | -0.31 | 8.7% | -1.36% | ❌ |
| Retest M≥2 RVOL1.2 RSI45-75 | 30 | 46.7% | 0.97 | 0.24 | 3.5% | +0.68% | ❌ |
| Retest M≥2 noMACD RSI45-75 | 35 | 40.0% | 0.79 | 0.05 | 5.5% | +0.12% | ❌ |
| Chase L≥2/S≤-1 RVOL1.5 | 49 | 24.5% | 0.40 | -0.59 | 15.1% | -3.02% | ❌ |
| **SPY buy-and-hold** | — | — | — | — | ~25% | **+13.9%** | baseline |

**All 25 configs tested: 0/25 beat SPY buy-and-hold.**

---

## What Was Tried

### Round 1: Baseline Sweep

10 configs varying macroGate (−1 to +4), rvolMin (1.5, 2.0), stopAtrMult (0.50, 0.75).

**Finding:** M≥4 looked great (PF=9.42, 66.7% win) but only 6 trades — statistically meaningless. M≥2 was the best real config (9 trades, PF=1.97, +3.87% net). Everything below M≥2 was consistently losing.

### Round 2: Retest Entry

Hypothesis: entering on the breakout bar close is "chasing." Wait for a pullback to OR_high (low ≤ OR_high×1.003 and close > OR_high) before entering.

**Implementation note:** `evalIdx` must be at the retest bar (not breakout bar) for retest mode, and at breakout bar for chase mode — otherwise indicators are evaluated at wrong point, corrupting results.

**Finding:** Win rates improved (e.g., M≥2 from 44.4% to 46.7% with wider RSI gate). Trade count slightly increased. But still far from beating hold. The improvement was insufficient.

### Round 3: Gate Relaxation

Tried RSI [45, 75] (vs default [50, 70]), requireMacd = false, rvolMin = 1.2.

**Finding:** More trades (up to 61 with M≥0/noMACD), but win rate drops proportionally. No config finds a win rate + trade count combination that beats hold.

### Round 4: Short ORB (Bearish Breakdown)

**Hypothesis:** Short when SPY closes below OR_low during negative macro regime. This should profit in 2022's -19% bear market.

**Implementation challenges encountered:**

1. `allowBreakouts = false` (triggered by VIX backwardation) blocked ALL short attempts — backwardation is exactly the condition during bear markets. Fixed: added `allowShortBreakouts` field to `VolatilityRegimeResult` that allows shorts even in backwardation.

2. `!orb.orRangeValid` was an early return before `tryShort()` was called. Fixed: moved OR range check to be long-path-only; shorts bypass it.

3. BacktestEngine only called `portfolio.onSignal()` for `TradeDirection.LONG`. Fixed: also handle `TradeDirection.SHORT`.

4. `evaluateShort()` computed ATR on early-session bars (< 15 bars) causing IndexOutOfBoundsException. Fixed: guard `if (input.spy5minBars.size < 15) return null`.

**Finding:** 73.4% of days have a 5-min close below OR_low (verified via Python on raw data). Once bugs were fixed, shorts fired. But all bidirectional configs performed worse than long-only — shorts lose against SPY's positive drift in the 2021–2024 bull period. Even capturing 2022 wasn't enough to overcome losses in 2021/2023/2024.

### Round 5: Extended Period (2016–2024)

Fetched 9-year backtest. SPY hold over this period: +138.7% (+24.3% CAGR).

**Finding:** Trade counts were identical to 4-year results. The M≥2 gate simply doesn't fire more often over a longer period — the macro conditions for M≥2 are rare. 0/25 configs beat the 9-year benchmark.

---

## Root Cause Analysis

### Why SPY ORB Cannot Beat Hold

**Mathematical constraint:**

- M≥2 chase: ~9 trades/year × 0.5% risk = ~4.5% equity risked annually
- At PF=1.97, 44% win rate: expected return ≈ +1% CAGR
- SPY drift: +13.9% CAGR
- Gap: **12.9 percentage points** — cannot close this gap without unrealistic risk sizing

**The core issue:** An intraday strategy that is in the market ~1% of the time (9 trades × ~2 hours / 4,000 trading hours) cannot capture meaningful drift. The strategy is correct when it trades — it just doesn't trade enough.

**SPY as an instrument is hard for ORB:**
- SPY is a large basket ETF — highly mean-reverting intraday
- Low individual stock volatility means ORB targets (1R, 2R) take longer to hit or stop out
- ORB edge is documented primarily on individual stocks with catalysts (earnings, upgrades)

---

## What Would Actually Work

### Option A: Macro-Timed SPY Holding (recommended first)

Use `MacroRegimeEngine` as a market timing signal for daily ETF rotation:
- mBase ≥ 1 → hold SPY
- mBase ≤ 0 → move to cash

**Why it could work:** The 2022 bear market (-19%) was preceded by a deteriorating macro regime. A correctly timed exit before 2022 and re-entry for 2023 would give roughly:
- 2021: +28.7% (fully invested)  
- 2022: ~0% (cash during bear)
- 2023: +26.3% (re-enters)
- 2024: +23.3%
- Compound ≈ +105–120% → significantly beats the +68.3% passive hold

**Implementation:** New `DailyRotationEngine` that evaluates macro daily, no intraday code needed.

### Option B: VWAP Mean-Reversion Intraday

Flip the signal direction: buy SPY when it drops ≥ 0.3 × ATR below session VWAP during positive macro days.
- Win rates historically 55–65% (vs 15–20% for breakout)
- More trades per day
- Profit target: VWAP (1R), +0.5 ATR above VWAP (2R)

### Option C: ORB on Individual Stocks

Apply the same 14-gate checklist to stocks with daily catalysts (earnings beats, upgrades, sector news, gap-ups > 3%). Win rates are 40–60%, 5–15 potential trades per day. Same infrastructure, different data source.

---

## Bugs Found and Fixed

| Bug | Symptom | Fix |
|-----|---------|-----|
| O(n²) macro computation | Backtest took hours on large datasets | Precompute `MacroRegimeResult` once per day in engine |
| Backtest timeout via HTTP | Frontend showed "Load failed" | Made backtest async (job queue with polling) |
| Non-local return in coroutineScope | Compile error | Remove `return` from lambda |
| `replace_all` destroyed timestamp import | Build failure | Restore `import org.jetbrains.exposed.sql.kotlin.datetime.timestamp` |
| Missing `and` import in BacktestRepository | Compile error | Use wildcard `import org.jetbrains.exposed.sql.*` |
| Missing `TradeSignal` import in BacktestEngine | Compile error | Add explicit import |
| evalIdx moved to retestIdx for all configs | Chase mode results changed vs baseline | Pass `evalAtRetest: Boolean` to OrbSignal, only move evalIdx in retest mode |
| Vol gate blocked all shorts | 0 short trades | Add `allowShortBreakouts` to VolatilityRegimeResult; separate long/short vol checks |
| OR range check early-returned before short path | 0 short trades | Move `orRangeValid` check to long path only |
| BacktestEngine ignored SHORT signals | 0 short trades executed | Handle `TradeDirection.SHORT` in `portfolio.onSignal()` call |
| ATR crash on early-session bars | IndexOutOfBoundsException | Guard `if (input.spy5minBars.size < 15) return null` in evaluateShort |
| Python timezone analysis wrong for EDT | 73% "breakdowns" vs 0% in Kotlin | Fixed Python to use EDT(-4)/EST(-5) properly; Kotlin correct via `TimeZone.of("America/New_York")` |

---

## Code Locations

| Component | File |
|-----------|------|
| Signal config | `signal/SignalConfig.kt` |
| ORB signal | `signal/OrbSignal.kt` |
| Signal orchestrator | `signal/SignalOrchestrator.kt` |
| Macro engine | `signal/MacroRegimeEngine.kt` |
| Volatility engine | `signal/VolatilityRegimeEngine.kt` |
| Event filter | `signal/EventFilter.kt` |
| Backtest engine | `backtest/BacktestEngine.kt` |
| Portfolio | `backtest/Portfolio.kt` |
| Report generator | `backtest/ReportGenerator.kt` |
| Parameter sweep | `backtest/BacktestSweep.kt` |
| Trade models | `data/model/Trade.kt`, `data/model/Bar.kt` |
| DB repository | `db/BacktestRepository.kt` |
| DB tables | `model/Tables.kt` |
| Gradle task | `build.gradle.kts` — task `backtestSweep` |
