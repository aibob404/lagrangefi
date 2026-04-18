import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Line, ResponsiveContainer } from 'recharts'
import type { Position, PoolState, StrategyEvent, Strategy, StrategyStats } from '../types'
import {
  fetchPosition, fetchPoolState, fetchRebalances, fetchStrategies, fetchStrategyStats,
  pauseStrategy, stopStrategy,
} from '../api'
import { useAuth } from '../context/AuthContext'
import {
  computeTotalReturn, computeCompareToHold, computeTokenRatio, rawToFloat,
} from '../finance'

// ── Formatting helpers ──────────────────────────────────────────────────────
const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
const tokenLabel = (addr: string) =>
  TOKEN_LABELS[addr.toLowerCase()] ?? addr.slice(0, 6) + '…' + addr.slice(-4)
const feeLabel = (fee: number) => (fee / 10000).toFixed(2) + '%'
const shortHash = (h: string) => h.slice(0, 6) + '…' + h.slice(-4)
const tickToPrice = (tick: number, d0: number, d1: number) =>
  Math.pow(1.0001, tick) * Math.pow(10, d0 - d1)
const formatPrice = (p: number) =>
  p.toLocaleString('en-US', { maximumFractionDigits: p < 1 ? 6 : 2 })
const formatUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const formatSignedUsd = (n: number) => (n >= 0 ? '+' : '−') + formatUsd(Math.abs(n))
const formatPct = (p: number, digits = 2) =>
  (p >= 0 ? '+' : '') + p.toFixed(digits) + '%'

const daysRunning = (iso: string) =>
  Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(days / 7)
  return `${weeks}w ago`
}

// Detect price orientation — if token0 is the stable, flip the tick-derived price.
function makeDisplayPrice(token0Addr: string, d0: number, d1: number) {
  const token0Stable = /USDC|USDT|DAI/.test(tokenLabel(token0Addr))
  return (tick: number) => {
    const p = tickToPrice(tick, d0, d1)
    return token0Stable ? 1 / p : p
  }
}

// ── Tiny UI primitives ──────────────────────────────────────────────────────
function Card({
  children, className = '', padded = true,
}: { children: React.ReactNode; className?: string; padded?: boolean }) {
  return (
    <div
      className={`bg-slate-800/70 backdrop-blur-md rounded-xl border border-slate-700 shadow-lg shadow-black/20 ${padded ? 'p-5' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-slate-700/60 rounded-md ${className}`} />
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-[0.14em]">
      {children}
    </p>
  )
}

// ── Toast ────────────────────────────────────────────────────────────────────
type Toast = { id: number; kind: 'error' | 'info'; msg: string }

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-xl shadow-black/40 backdrop-blur-md text-sm border animate-[fadein_0.2s_ease-out] ${
            t.kind === 'error'
              ? 'bg-rose-500/15 border-rose-500/40 text-rose-200'
              : 'bg-slate-700/90 border-slate-600 text-slate-100'
          }`}
        >
          <span className="flex-1">{t.msg}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="text-slate-400 hover:text-slate-100 shrink-0"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Quick actions ────────────────────────────────────────────────────────────
function QuickActions({
  strategy, onAction,
}: { strategy: Strategy; onAction: (kind: 'pause' | 'stop') => Promise<void> }) {
  const [busy, setBusy] = useState<null | 'pause' | 'stop'>(null)
  const [confirmStop, setConfirmStop] = useState(false)

  async function run(kind: 'pause' | 'stop') {
    setBusy(kind)
    try { await onAction(kind) } finally { setBusy(null); setConfirmStop(false) }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => run('pause')}
        disabled={busy !== null || strategy.status !== 'ACTIVE'}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700 hover:border-slate-600 text-xs font-semibold text-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
        {busy === 'pause' ? 'Pausing…' : 'Pause'}
      </button>

      {confirmStop ? (
        <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-500/40 bg-rose-500/10">
          <span className="text-xs text-rose-200 pr-1">Stop strategy?</span>
          <button
            onClick={() => run('stop')}
            disabled={busy !== null}
            className="px-2 py-0.5 rounded-md bg-rose-500 hover:bg-rose-400 text-slate-950 text-xs font-semibold disabled:opacity-50"
          >
            {busy === 'stop' ? '…' : 'Confirm'}
          </button>
          <button
            onClick={() => setConfirmStop(false)}
            disabled={busy !== null}
            className="px-2 py-0.5 rounded-md text-xs text-slate-400 hover:text-slate-100"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmStop(true)}
          disabled={busy !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-semibold text-rose-300 transition-colors disabled:opacity-50"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
          Stop
        </button>
      )}
    </div>
  )
}

// ── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div className="h-8" />
  const points = data.map((v, i) => ({ i, v }))
  return (
    <div className="h-8 -mx-1">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Hero P&L panel ───────────────────────────────────────────────────────────
function HeroPnL({
  strategy, stats, position, poolState,
}: { strategy: Strategy; stats: StrategyStats; position: Position; poolState: PoolState }) {
  const label0 = tokenLabel(strategy.token0)
  const dec0 = strategy.token0Decimals
  const dec1 = strategy.token1Decimals
  const ethPrice = parseFloat(poolState.price)

  const totalReturn = useMemo(() => computeTotalReturn(
    strategy, stats, dec0, dec1, label0, ethPrice,
    position.amount0, position.amount1,
    position.tokensOwed0, position.tokensOwed1,
  ), [strategy, stats, dec0, dec1, label0, ethPrice, position])

  if (!totalReturn) {
    return (
      <Card>
        <SectionLabel>Net P&L</SectionLabel>
        <p className="text-4xl font-bold text-slate-100 mt-2">—</p>
        <p className="text-xs text-slate-500 mt-1">
          Awaiting initial deposit valuation
        </p>
      </Card>
    )
  }

  const compare = computeCompareToHold(
    strategy, dec0, dec1, label0, ethPrice, totalReturn.currentTotalValueUsd,
  )

  const positive = totalReturn.totalReturnUsd >= 0
  const color = positive ? 'text-emerald-400' : 'text-rose-400'

  const days = daysRunning(strategy.createdAt)

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <SectionLabel>Net P&amp;L · since inception</SectionLabel>
          <div className="flex items-baseline gap-3 mt-2">
            <p className={`text-4xl font-bold tracking-tight tabular-nums ${color}`}>
              {formatSignedUsd(totalReturn.totalReturnUsd)}
            </p>
            {totalReturn.totalReturnPct !== null && (
              <p className={`text-lg font-semibold tabular-nums ${color}`}>
                {formatPct(totalReturn.totalReturnPct)}
              </p>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Position value {formatUsd(totalReturn.currentTotalValueUsd)}
            {strategy.initialValueUsd && <> · opened at {formatUsd(strategy.initialValueUsd)} · {days}d running</>}
          </p>
        </div>

        {compare && (
          <div className="text-right">
            <SectionLabel>vs HODL</SectionLabel>
            <p className={`text-lg font-bold tabular-nums mt-1 ${compare.compareUsd <= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {formatSignedUsd(-compare.compareUsd)}
            </p>
            <p className="text-xs text-slate-500">
              HODL would be {formatUsd(compare.hodlValueUsd)}
            </p>
          </div>
        )}
      </div>

      {/* Value breakdown chips */}
      <div className="mt-4 flex flex-wrap gap-2">
        <BreakdownChip label="LP principal" value={totalReturn.lpValueUsd} />
        <BreakdownChip label="Unclaimed fees" value={totalReturn.unclaimedFeesUsd} />
        {totalReturn.pendingValueUsd > 0.01 && (
          <BreakdownChip label="Pending" value={totalReturn.pendingValueUsd} />
        )}
        <BreakdownChip label="Gas spent" value={-totalReturn.gasSpentUsd} negative />
      </div>
    </Card>
  )
}

function BreakdownChip({ label, value, negative }: { label: string; value: number; negative?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-700/60 border border-slate-600/60">
      <span className="text-[11px] text-slate-400">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${negative ? 'text-rose-400' : 'text-slate-100'}`}>
        {negative ? formatSignedUsd(value) : formatUsd(value)}
      </span>
    </div>
  )
}

// ── Secondary KPI card ───────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, spark, accent,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  spark?: { data: number[]; color: string }
  accent?: 'green' | 'red' | 'amber'
}) {
  const color =
    accent === 'green' ? 'text-emerald-400' :
    accent === 'red'   ? 'text-rose-400'    :
    accent === 'amber' ? 'text-amber-400'   :
    'text-slate-100'
  return (
    <Card>
      <SectionLabel>{label}</SectionLabel>
      <p className={`text-2xl font-bold tracking-tight mt-2 tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
      {spark && <Sparkline data={spark.data} color={spark.color} />}
    </Card>
  )
}

// ── Range hero (full width) ─────────────────────────────────────────────────
function RangeHero({
  position, poolState, lastRebalanceAt,
}: { position: Position; poolState: PoolState; lastRebalanceAt: string | null }) {
  const display = makeDisplayPrice(position.token0, poolState.decimals0, poolState.decimals1)
  const edgeA = display(position.tickLower)
  const edgeB = display(position.tickUpper)
  const lo = Math.min(edgeA, edgeB)
  const hi = Math.max(edgeA, edgeB)
  const cur = parseFloat(poolState.price)

  const inRange = poolState.tick >= position.tickLower && poolState.tick < position.tickUpper
  const width = hi - lo
  const widthPct = hi + lo > 0 ? (width / ((hi + lo) / 2)) * 100 : 0

  const toLowerPct = cur > 0 ? ((cur - lo) / cur) * 100 : 0
  const toUpperPct = cur > 0 ? ((hi - cur) / cur) * 100 : 0

  const pad = Math.max(hi - lo, Math.max(cur * 0.001, 1e-9)) * 0.25
  const min = lo - pad, max = hi + pad
  const total = max - min
  const pct = (p: number) => Math.max(0, Math.min(100, ((p - min) / total) * 100))
  const loPct = pct(lo), hiPct = pct(hi)
  const curPct = pct(cur)

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <SectionLabel>Active range</SectionLabel>
          <p className="text-2xl font-bold text-slate-100 mt-1 tabular-nums">
            ${formatPrice(cur)}
            <span className="text-sm font-medium text-slate-500 ml-2">{tokenLabel(position.token1)}/{tokenLabel(position.token0)}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${
            inRange
              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
              : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
            {inRange ? 'In Range' : 'Out of Range'}
          </span>
          {lastRebalanceAt && (
            <span className="text-xs text-slate-400">
              Last rebalance {relativeTime(lastRebalanceAt)}
            </span>
          )}
        </div>
      </div>

      {/* Bar */}
      <div className="relative h-4 bg-slate-700/80 rounded-full ring-1 ring-inset ring-slate-700/50">
        <div
          className={`absolute h-full rounded-full ${inRange ? 'bg-emerald-500/25' : 'bg-rose-500/25'}`}
          style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }}
        />
        {/* edges */}
        <div className="absolute top-0 bottom-0 w-px bg-emerald-400/80" style={{ left: `${loPct}%` }} />
        <div className="absolute top-0 bottom-0 w-px bg-emerald-400/80" style={{ left: `${hiPct}%` }} />
        {/* current price marker */}
        <div
          className={`absolute top-1/2 w-1 h-6 rounded-full ${inRange ? 'bg-emerald-400' : 'bg-rose-400'} shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_12px_rgba(52,211,153,0.6)]`}
          style={{ left: `${curPct}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>

      {/* Tick labels */}
      <div className="flex justify-between mt-2 text-xs font-mono text-slate-500">
        <span>${formatPrice(lo)}</span>
        <span>${formatPrice(hi)}</span>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
        <RangeMetric
          label="To lower edge"
          value={`${toLowerPct >= 0 ? '-' : '+'}${Math.abs(toLowerPct).toFixed(2)}%`}
          sub={`$${formatPrice(lo)}`}
          accent={toLowerPct < 2 ? 'amber' : undefined}
        />
        <RangeMetric
          label="To upper edge"
          value={`${toUpperPct >= 0 ? '+' : '-'}${Math.abs(toUpperPct).toFixed(2)}%`}
          sub={`$${formatPrice(hi)}`}
          accent={toUpperPct < 2 ? 'amber' : undefined}
        />
        <RangeMetric
          label="Range width"
          value={`±${(widthPct / 2).toFixed(2)}%`}
          sub={`$${formatPrice(width)} spread`}
        />
        <RangeMetric
          label="Position"
          value={`#${position.tokenId}`}
          sub={
            <a
              href={`https://app.uniswap.org/pools/${position.tokenId}?chain=arbitrum`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              View on Uniswap ↗
            </a>
          }
        />
      </div>
    </Card>
  )
}

function RangeMetric({
  label, value, sub, accent,
}: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: 'amber' }) {
  const color = accent === 'amber' ? 'text-amber-400' : 'text-slate-100'
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-slate-500 uppercase tracking-[0.14em]">{label}</p>
      <p className={`text-sm font-bold tabular-nums mt-0.5 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5 truncate">{sub}</p>}
    </div>
  )
}

// ── Composition (token ratio + amounts) ──────────────────────────────────────
function Composition({
  strategy, position, poolState,
}: { strategy: Strategy; position: Position; poolState: PoolState }) {
  const label0 = tokenLabel(strategy.token0)
  const label1 = tokenLabel(strategy.token1)
  const dec0 = strategy.token0Decimals
  const dec1 = strategy.token1Decimals
  const ethPrice = parseFloat(poolState.price)

  const ratio = position.amount0 && position.amount1
    ? computeTokenRatio(position.amount0, position.amount1, dec0, dec1, label0, ethPrice)
    : null

  const held0 = position.amount0 ? rawToFloat(position.amount0, dec0) : null
  const held1 = position.amount1 ? rawToFloat(position.amount1, dec1) : null
  const liq = BigInt(position.liquidity) > 0n

  return (
    <Card className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Composition</SectionLabel>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
          liq
            ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
            : 'bg-slate-700 text-slate-500 border border-slate-600'
        }`}>
          {liq ? 'Active liquidity' : 'Empty'}
        </span>
      </div>

      {ratio ? (
        <>
          <div className="flex h-2 rounded-full overflow-hidden mb-3 bg-slate-700">
            <div className="bg-emerald-400/80" style={{ width: `${ratio.token0Pct}%` }} />
            <div className="bg-sky-400/80" style={{ width: `${ratio.token1Pct}%` }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-xs font-semibold text-slate-300">{label0}</span>
                <span className="text-xs text-slate-500 ml-auto">{ratio.token0Pct.toFixed(1)}%</span>
              </div>
              <p className="text-lg font-bold text-slate-100 mt-1 tabular-nums">
                {held0!.toLocaleString('en-US', { maximumFractionDigits: held0! < 1 ? 6 : 2 })}
              </p>
              <p className="text-xs text-slate-500 tabular-nums">{formatUsd(ratio.token0Usd)}</p>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
                <span className="text-xs font-semibold text-slate-300">{label1}</span>
                <span className="text-xs text-slate-500 ml-auto">{ratio.token1Pct.toFixed(1)}%</span>
              </div>
              <p className="text-lg font-bold text-slate-100 mt-1 tabular-nums">
                {held1!.toLocaleString('en-US', { maximumFractionDigits: held1! < 1 ? 6 : 2 })}
              </p>
              <p className="text-xs text-slate-500 tabular-nums">{formatUsd(ratio.token1Usd)}</p>
            </div>
          </div>
        </>
      ) : (
        <p className="text-xs text-slate-500">Position amounts not available</p>
      )}
    </Card>
  )
}

// ── Rebalance table ─────────────────────────────────────────────────────────
function RebalancesTable({
  rebalances, strategy, poolState,
}: { rebalances: StrategyEvent[]; strategy: Strategy; poolState: PoolState | null }) {
  const display = useMemo(
    () => poolState ? makeDisplayPrice(strategy.token0, poolState.decimals0, poolState.decimals1) : null,
    [strategy.token0, poolState],
  )
  const label0 = tokenLabel(strategy.token0)

  const rebalanceEvents = rebalances.filter(r => r.action === 'REBALANCE')

  if (rebalanceEvents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center mb-3 border border-slate-600">
          <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </div>
        <p className="text-sm text-slate-300">No rebalances yet</p>
        <p className="text-xs text-slate-500 mt-0.5">They'll appear here as the strategy rebalances.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-slate-500 uppercase tracking-[0.14em] border-b border-slate-700">
            <th className="text-left pb-2.5 font-semibold">When</th>
            <th className="text-left pb-2.5 font-semibold">New range</th>
            <th className="text-right pb-2.5 font-semibold">Fees</th>
            <th className="text-right pb-2.5 font-semibold">Gas</th>
            <th className="text-right pb-2.5 font-semibold">Net</th>
            <th className="text-right pb-2.5 font-semibold"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {rebalanceEvents.slice(0, 10).map(r => {
            const d = r.rebalanceDetails
            const isSuccess = r.status === 'success'
            const ethPrice = d?.ethPriceUsd ?? 0

            const feesUsd = d && d.feesCollectedToken0 && d.feesCollectedToken1 && ethPrice
              ? (label0.includes('WETH')
                ? rawToFloat(d.feesCollectedToken0, strategy.token0Decimals) * ethPrice + rawToFloat(d.feesCollectedToken1, strategy.token1Decimals)
                : rawToFloat(d.feesCollectedToken1, strategy.token1Decimals) * ethPrice + rawToFloat(d.feesCollectedToken0, strategy.token0Decimals))
              : null

            const gasUsd = d?.gasUsedWei != null && ethPrice
              ? (d.gasUsedWei / 1e18) * ethPrice : null
            const netUsd = feesUsd !== null && gasUsd !== null ? feesUsd - gasUsd : null

            const txHash = r.transactions[0]?.txHash
            return (
              <tr key={r.id} className="hover:bg-slate-700/40 transition-colors">
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSuccess ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span
                      className="text-sm text-slate-300 whitespace-nowrap"
                      title={new Date(r.triggeredAt).toLocaleString()}
                    >
                      {relativeTime(r.triggeredAt)}
                    </span>
                  </div>
                  {!isSuccess && r.errorMessage && (
                    <p className="text-[11px] text-rose-400 mt-0.5 truncate max-w-[180px]" title={r.errorMessage}>
                      {r.errorMessage}
                    </p>
                  )}
                </td>
                <td className="py-2.5 text-slate-300 font-mono text-xs">
                  {d?.newTickLower != null && d?.newTickUpper != null && display
                    ? `$${formatPrice(display(d.newTickLower))} – $${formatPrice(display(d.newTickUpper))}`
                    : <span className="text-slate-600">—</span>}
                </td>
                <td className="py-2.5 text-right tabular-nums text-slate-200">
                  {feesUsd !== null ? formatUsd(feesUsd) : <span className="text-slate-600">—</span>}
                </td>
                <td className="py-2.5 text-right tabular-nums text-slate-500">
                  {gasUsd !== null ? formatUsd(gasUsd) : <span className="text-slate-600">—</span>}
                </td>
                <td className={`py-2.5 text-right tabular-nums font-semibold ${
                  netUsd === null ? 'text-slate-600'
                  : netUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}>
                  {netUsd !== null ? formatSignedUsd(netUsd) : '—'}
                </td>
                <td className="py-2.5 text-right">
                  {txHash ? (
                    <a
                      href={`https://arbiscan.io/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={shortHash(txHash)}
                      className="inline-flex items-center text-slate-500 hover:text-sky-400 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                    </a>
                  ) : <span className="text-slate-700">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Onboarding ──────────────────────────────────────────────────────────────
function OnboardingState({ hasWallet }: { hasWallet: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 bg-slate-800 rounded-2xl flex items-center justify-center mb-5 border border-slate-700 shadow-[0_0_40px_rgba(16,185,129,0.15)]">
        <span className="text-2xl font-bold text-emerald-400">Δ</span>
      </div>
      <h2 className="text-lg font-bold text-slate-100 mb-2">Welcome to lagrangefi</h2>
      <p className="text-slate-400 text-sm max-w-xs mb-8">
        Automatically rebalances your Uniswap v3 ETH/USDC position to keep it in range.
      </p>

      <div className="flex flex-col items-center gap-3 w-full max-w-xs">
        <div className={`w-full flex items-center gap-4 rounded-xl border p-4 ${
          hasWallet
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : 'bg-slate-800/70 border-slate-700'
        }`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
            hasWallet ? 'bg-emerald-400 text-slate-950' : 'bg-slate-700 text-slate-100 border border-slate-600'
          }`}>
            {hasWallet ? '✓' : '1'}
          </div>
          <div className="text-left">
            <p className={`text-sm font-semibold ${hasWallet ? 'text-emerald-300' : 'text-slate-100'}`}>
              {hasWallet ? 'Wallet configured' : 'Add your wallet'}
            </p>
            {!hasWallet && <p className="text-xs text-slate-500">BIP39 mnemonic or private key</p>}
          </div>
          {!hasWallet && (
            <Link to="/profile" className="ml-auto bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              Go →
            </Link>
          )}
        </div>
        <div className={`w-full flex items-center gap-4 rounded-xl border p-4 ${
          hasWallet
            ? 'bg-slate-800/70 border-slate-700'
            : 'bg-slate-800/30 border-slate-700/60 opacity-50'
        }`}>
          <div className="w-8 h-8 rounded-full bg-slate-700 text-slate-100 border border-slate-600 flex items-center justify-center text-sm font-bold shrink-0">2</div>
          <div className="text-left">
            <p className="text-sm font-semibold text-slate-100">Create a strategy</p>
            <p className="text-xs text-slate-500">Deposit ETH + USDC, set range width</p>
          </div>
          {hasWallet && (
            <Link to="/strategies" className="ml-auto bg-emerald-400 hover:bg-emerald-300 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              Go →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Dashboard skeleton (first load) ─────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-48 w-full" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-48 md:col-span-2" />
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { user } = useAuth()

  const [position,   setPosition]   = useState<Position | null>(null)
  const [poolState,  setPoolState]  = useState<PoolState | null>(null)
  const [rebalances, setRebalances] = useState<StrategyEvent[]>([])
  const [strategy,   setStrategy]   = useState<Strategy | null>(null)
  const [stats,      setStats]      = useState<StrategyStats | null>(null)

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshing,  setRefreshing]  = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [noStrategy,  setNoStrategy]  = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])

  const pushToast = useCallback((msg: string, kind: 'error' | 'info' = 'error') => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, kind, msg }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000)
  }, [])
  const dismissToast = useCallback(
    (id: number) => setToasts(t => t.filter(x => x.id !== id)),
    [],
  )

  const fetchAll = useCallback(async () => {
    setRefreshing(true)
    try {
      const strategies = await fetchStrategies()
      const active = strategies.find(s => s.status === 'ACTIVE') ?? null
      setStrategy(active)

      if (!active) {
        setNoStrategy(true)
        return
      }
      setNoStrategy(false)

      const [pos, pool, rebal, st] = await Promise.all([
        fetchPosition(),
        fetchPoolState(),
        fetchRebalances(),
        fetchStrategyStats(active.id),
      ])
      setPosition(pos)
      setPoolState(pool)
      setRebalances(rebal)
      setStats(st)
      setLastUpdated(new Date())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch data'
      if (msg !== 'Unauthorized') pushToast(msg)
    } finally {
      setRefreshing(false)
      setInitialLoading(false)
    }
  }, [pushToast])

  useEffect(() => {
    fetchAll()
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [fetchAll])

  async function handleAction(kind: 'pause' | 'stop') {
    if (!strategy) return
    try {
      if (kind === 'pause') {
        await pauseStrategy(strategy.id)
        pushToast('Strategy paused', 'info')
      } else {
        await stopStrategy(strategy.id)
        pushToast('Strategy stopped', 'info')
      }
      await fetchAll()
    } catch (e: unknown) {
      pushToast(e instanceof Error ? e.message : 'Action failed')
    }
  }

  const ethPrice = poolState ? parseFloat(poolState.price) : 0

  // ── Derived: rebalance-derived metrics ─────────────────────────────────────
  const {
    successCount, failedCount, successRate, lastRebalanceAt,
    cumulativeFeesSeries, netFeesUsd, feesUsd, gasUsd,
  } = useMemo(() => {
    const rebalanceEvents = rebalances.filter(r => r.action === 'REBALANCE')
    const successes = rebalanceEvents.filter(r => r.status === 'success')
    const failures  = rebalanceEvents.filter(r => r.status === 'failed')
    const total     = successes.length + failures.length
    const rate      = total > 0 ? Math.round((successes.length / total) * 100) : null
    const last      = rebalanceEvents[0]?.triggeredAt ?? null

    // Cumulative fees series (oldest → newest). rebalance events come newest first.
    const ordered = [...rebalanceEvents].reverse()
    let cum = 0
    const series: number[] = []
    for (const ev of ordered) {
      const d = ev.rebalanceDetails
      if (!d || !strategy || !d.feesCollectedToken0 || !d.feesCollectedToken1 || !d.ethPriceUsd) {
        series.push(cum)
        continue
      }
      const label0 = tokenLabel(strategy.token0)
      const f0 = rawToFloat(d.feesCollectedToken0, strategy.token0Decimals)
      const f1 = rawToFloat(d.feesCollectedToken1, strategy.token1Decimals)
      const thisFees = label0.includes('WETH')
        ? f0 * d.ethPriceUsd + f1
        : f1 * d.ethPriceUsd + f0
      cum += thisFees
      series.push(cum)
    }

    const feesUsd = stats?.feesCollectedUsd ?? 0
    const gasUsd  = stats?.gasCostUsd ?? 0
    const netFees = feesUsd - gasUsd

    return {
      successCount: successes.length,
      failedCount:  failures.length,
      successRate:  rate,
      lastRebalanceAt: last,
      cumulativeFeesSeries: series,
      netFeesUsd: netFees,
      feesUsd, gasUsd,
    }
  }, [rebalances, stats, strategy])

  // ── Onboarding state ──────────────────────────────────────────────────────
  if (noStrategy) {
    return (
      <div>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Uniswap v3 · Arbitrum</p>
        </div>
        <OnboardingState hasWallet={user?.hasWallet ?? false} />
      </div>
    )
  }

  if (initialLoading) {
    return (
      <div>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Loading…</p>
        </div>
        <DashboardSkeleton />
      </div>
    )
  }

  const hasData = strategy && position && poolState && stats
  const inRange = poolState && position
    ? poolState.tick >= position.tickLower && poolState.tick < position.tickUpper
    : null

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          {strategy && (
            <div className="flex items-center gap-2 mt-1 text-sm text-slate-400 flex-wrap">
              <span className="font-medium text-slate-200">{strategy.name}</span>
              <span className="text-slate-700">·</span>
              <span>{tokenLabel(strategy.token0)}/{tokenLabel(strategy.token1)}</span>
              <span className="text-slate-700">·</span>
              <span>{feeLabel(strategy.fee)}</span>
              {poolState && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="font-semibold text-slate-200 tabular-nums">${formatPrice(ethPrice)}</span>
                </>
              )}
              {inRange !== null && (
                <span className={`ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                  inRange
                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
                }`}>
                  <span className={`w-1 h-1 rounded-full ${inRange ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                  {inRange ? 'In range' : 'Out of range'}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              onClick={fetchAll}
              disabled={refreshing}
              title="Refresh"
              className="p-2 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-100 transition-colors disabled:opacity-50"
            >
              <svg
                className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {lastUpdated && (
              <span className="text-xs text-slate-500 whitespace-nowrap">
                {refreshing ? 'Refreshing…' : `Updated ${relativeTime(lastUpdated.toISOString())}`}
              </span>
            )}
          </div>
          {strategy && <QuickActions strategy={strategy} onAction={handleAction} />}
        </div>
      </div>

      {/* Hero P&L */}
      {hasData && (
        <div className="mb-4">
          <HeroPnL strategy={strategy} stats={stats} position={position} poolState={poolState} />
        </div>
      )}

      {/* Secondary KPIs */}
      {hasData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <KpiCard
            label="Net fees"
            value={formatSignedUsd(netFeesUsd)}
            sub={`${formatUsd(feesUsd)} earned · ${formatUsd(gasUsd)} gas`}
            spark={cumulativeFeesSeries.length >= 2
              ? { data: cumulativeFeesSeries, color: netFeesUsd >= 0 ? '#34d399' : '#fb7185' }
              : undefined}
            accent={netFeesUsd >= 0 ? 'green' : 'red'}
          />
          <KpiCard
            label="Time in range"
            value={`${stats.timeInRangePct.toFixed(1)}%`}
            sub={`${stats.inRangeTicks}/${stats.totalPollTicks} ticks · ${daysRunning(strategy.createdAt)}d`}
            accent={stats.timeInRangePct >= 70 ? 'green' : stats.timeInRangePct >= 40 ? 'amber' : 'red'}
          />
          <KpiCard
            label="Rebalances"
            value={stats.totalRebalances}
            sub={successRate !== null
              ? `${successRate}% success · ${successCount} ok · ${failedCount} failed`
              : 'No rebalances yet'}
          />
        </div>
      )}

      {/* Range hero */}
      {hasData && (
        <div className="mb-4">
          <RangeHero position={position} poolState={poolState} lastRebalanceAt={lastRebalanceAt} />
        </div>
      )}

      {/* Composition + rebalances */}
      {hasData && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Composition strategy={strategy} position={position} poolState={poolState} />
          <Card className="md:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>Recent rebalances</SectionLabel>
              <Link to="/strategies" className="text-xs text-sky-400 hover:text-sky-300 font-medium">
                Full history →
              </Link>
            </div>
            <RebalancesTable rebalances={rebalances} strategy={strategy} poolState={poolState} />
          </Card>
        </div>
      )}

      <ToastStack toasts={toasts} dismiss={dismissToast} />
    </div>
  )
}
