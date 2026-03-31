import type { Strategy, StrategyStats, StrategyEvent } from './types'

// ── Token helpers ────────────────────────────────────────────────────────────

export function rawToFloat(raw: string, decimals: number): number {
  return Number(BigInt(raw)) / Math.pow(10, decimals)
}

// ── Compare to Hold ──────────────────────────────────────────────────────────
// How does the LP strategy compare to simply holding the initial tokens?
//
// compareUsd = hodlValueUsd - currentTotalValueUsd
//   positive → HODL would be ahead by that amount (LP underperforming)
//   negative → LP strategy is ahead by abs(compareUsd) (LP outperforming)
//
// currentTotalValueUsd comes from computeTotalReturn (LP + unclaimed fees + pending).

export interface CompareToHoldResult {
  compareUsd: number          // hodlValue - totalValue; positive = HODL winning
  comparePct: number          // as % of hodl value
  hodlValueUsd: number
  currentTotalValueUsd: number
}

export function computeCompareToHold(
  strategy: Strategy,
  dec0: number,
  dec1: number,
  label0: string,
  currentEthPrice: number,
  currentTotalValueUsd: number,   // from computeTotalReturn
): CompareToHoldResult | null {
  if (!strategy.initialToken0Amount || !strategy.initialToken1Amount) return null

  const init0 = rawToFloat(strategy.initialToken0Amount, dec0)
  const init1 = rawToFloat(strategy.initialToken1Amount, dec1)

  const hodlValueUsd = label0.includes('WETH')
    ? init0 * currentEthPrice + init1
    : init1 * currentEthPrice + init0

  const compareUsd = hodlValueUsd - currentTotalValueUsd
  const comparePct = hodlValueUsd > 0 ? (compareUsd / hodlValueUsd) * 100 : 0

  return { compareUsd, comparePct, hodlValueUsd, currentTotalValueUsd }
}

// ── Total Return (#2) ────────────────────────────────────────────────────────
// Net Return = currentTotalValueUsd - initialValueUsd - gasCostUsd
//
// currentTotalValueUsd (active)  = LP principal + unclaimed fees + pending wallet tokens
// currentTotalValueUsd (stopped) = endValueUsd (already includes pending + collected at close)

export interface TotalReturnResult {
  totalReturnUsd: number
  totalReturnPct: number | null
  currentTotalValueUsd: number
  lpValueUsd: number          // LP principal only
  unclaimedFeesUsd: number    // tokensOwed (not yet collected)
  pendingValueUsd: number     // wallet leftover from last mint cycle
  gasSpentUsd: number
}

export function computeTotalReturn(
  strategy: Strategy,
  stats: StrategyStats,
  dec0: number,
  dec1: number,
  label0: string,
  currentEthPrice: number,
  // For active strategies: live LP principal amounts
  liveToken0Raw?: string,
  liveToken1Raw?: string,
  // For active strategies: unclaimed fees sitting in the position (tokensOwed)
  liveTokensOwed0Raw?: string,
  liveTokensOwed1Raw?: string,
): TotalReturnResult | null {
  if (!strategy.initialValueUsd) return null

  const gasSpentUsd = stats.gasCostUsd > 0
    ? stats.gasCostUsd
    : ((stats.gasCostWei / 1e18) * currentEthPrice)

  let currentTotalValueUsd: number
  let lpValueUsd: number
  let unclaimedFeesUsd = 0
  let pendingValueUsd = 0

  if (strategy.status === 'STOPPED_MANUALLY' || strategy.status === 'STOPPED_ON_ERROR') {
    // endValueUsd already includes pending + all collected tokens at close price
    if (strategy.endValueUsd != null) {
      currentTotalValueUsd = strategy.endValueUsd
      lpValueUsd = strategy.endValueUsd
    } else if (strategy.endToken0Amount && strategy.endToken1Amount && strategy.endEthPriceUsd) {
      const c0 = rawToFloat(strategy.endToken0Amount, dec0)
      const c1 = rawToFloat(strategy.endToken1Amount, dec1)
      currentTotalValueUsd = label0.includes('WETH')
        ? c0 * strategy.endEthPriceUsd + c1
        : c1 * strategy.endEthPriceUsd + c0
      lpValueUsd = currentTotalValueUsd
    } else {
      return null
    }
  } else {
    if (!liveToken0Raw || !liveToken1Raw) return null

    const t0 = rawToFloat(liveToken0Raw, dec0)
    const t1 = rawToFloat(liveToken1Raw, dec1)
    lpValueUsd = label0.includes('WETH')
      ? t0 * currentEthPrice + t1
      : t1 * currentEthPrice + t0

    if (liveTokensOwed0Raw && liveTokensOwed1Raw) {
      const o0 = rawToFloat(liveTokensOwed0Raw, dec0)
      const o1 = rawToFloat(liveTokensOwed1Raw, dec1)
      unclaimedFeesUsd = label0.includes('WETH')
        ? o0 * currentEthPrice + o1
        : o1 * currentEthPrice + o0
    }

    const p0 = rawToFloat(strategy.pendingToken0, dec0)
    const p1 = rawToFloat(strategy.pendingToken1, dec1)
    pendingValueUsd = label0.includes('WETH')
      ? p0 * currentEthPrice + p1
      : p1 * currentEthPrice + p0

    currentTotalValueUsd = lpValueUsd + unclaimedFeesUsd + pendingValueUsd
  }

  const totalReturnUsd = currentTotalValueUsd - strategy.initialValueUsd - gasSpentUsd
  const totalReturnPct = strategy.initialValueUsd > 0
    ? (totalReturnUsd / strategy.initialValueUsd) * 100
    : null

  return { totalReturnUsd, totalReturnPct, currentTotalValueUsd, lpValueUsd, unclaimedFeesUsd, pendingValueUsd, gasSpentUsd }
}

// ── APY (#6) ─────────────────────────────────────────────────────────────────

export function computeAPY(
  totalReturnUsd: number,
  initialValueUsd: number,
  daysRunning: number,
): number | null {
  if (initialValueUsd <= 0 || daysRunning <= 0) return null
  const returnPct = totalReturnUsd / initialValueUsd
  return (returnPct / (daysRunning / 365)) * 100
}

// ── Break-even (#8) ──────────────────────────────────────────────────────────
// How much more in fees needed to recover all gas + open costs.
// Uses average fee rate from rebalances to estimate days remaining.

export interface BreakEvenResult {
  breakEvenUsd: number        // total cost basis (gas spent)
  feesCollectedUsd: number
  remainingUsd: number        // max(0, breakEvenUsd - feesCollectedUsd)
  isBreakEven: boolean
  estimatedDays: number | null
}

export function computeBreakEven(
  stats: StrategyStats,
  daysRunning: number,
): BreakEvenResult {
  const feesCollectedUsd = stats.feesCollectedUsd
  const breakEvenUsd = stats.gasCostUsd
  const remainingUsd = Math.max(0, breakEvenUsd - feesCollectedUsd)
  const isBreakEven = feesCollectedUsd >= breakEvenUsd

  let estimatedDays: number | null = null
  if (!isBreakEven && daysRunning > 0 && feesCollectedUsd > 0) {
    const dailyFeeRate = feesCollectedUsd / daysRunning
    estimatedDays = dailyFeeRate > 0 ? Math.ceil(remainingUsd / dailyFeeRate) : null
  }

  return { breakEvenUsd, feesCollectedUsd, remainingUsd, isBreakEven, estimatedDays }
}

// ── Token ratio (#9) ─────────────────────────────────────────────────────────
// Returns what % of position value is in token0 vs token1.

export interface TokenRatio {
  token0Pct: number
  token1Pct: number
  token0Usd: number
  token1Usd: number
  totalUsd: number
}

export function computeTokenRatio(
  token0Raw: string,
  token1Raw: string,
  dec0: number,
  dec1: number,
  label0: string,
  ethPrice: number,
): TokenRatio {
  const t0 = rawToFloat(token0Raw, dec0)
  const t1 = rawToFloat(token1Raw, dec1)
  const token0Usd = label0.includes('WETH') ? t0 * ethPrice : t0
  const token1Usd = label0.includes('WETH') ? t1 : t1 * ethPrice
  const totalUsd = token0Usd + token1Usd
  const token0Pct = totalUsd > 0 ? (token0Usd / totalUsd) * 100 : 50
  const token1Pct = 100 - token0Pct
  return { token0Pct, token1Pct, token0Usd, token1Usd, totalUsd }
}

// ── Per-rebalance profitability (#5) ─────────────────────────────────────────

export interface RebalanceProfit {
  feesUsd: number
  gasUsd: number
  netUsd: number
  isProfitable: boolean
}

export function computeRebalanceProfit(
  event: StrategyEvent,
  dec0: number,
  dec1: number,
  label0: string,
): RebalanceProfit | null {
  const d = event.rebalanceDetails
  if (!d?.feesCollectedToken0 || !d?.feesCollectedToken1 || d?.gasUsedWei == null || d?.ethPriceUsd == null) return null
  const ethPrice = d.ethPriceUsd
  const f0 = rawToFloat(d.feesCollectedToken0, dec0)
  const f1 = rawToFloat(d.feesCollectedToken1, dec1)
  const feesUsd = label0.includes('WETH') ? f0 * ethPrice + f1 : f1 * ethPrice + f0
  const gasUsd = (d.gasUsedWei / 1e18) * ethPrice
  const netUsd = feesUsd - gasUsd
  return { feesUsd, gasUsd, netUsd, isProfitable: netUsd >= 0 }
}

// ── Historical USD values (#3) ───────────────────────────────────────────────
// Deposit value at open price (not current price)

export function depositValueAtOpen(
  strategy: Strategy,
  dec0: number,
  dec1: number,
  label0: string,
): number | null {
  if (!strategy.initialToken0Amount || !strategy.initialToken1Amount || !strategy.openEthPriceUsd) return null
  const t0 = rawToFloat(strategy.initialToken0Amount, dec0)
  const t1 = rawToFloat(strategy.initialToken1Amount, dec1)
  return label0.includes('WETH')
    ? t0 * strategy.openEthPriceUsd + t1
    : t1 * strategy.openEthPriceUsd + t0
}
