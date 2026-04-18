import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import type { Position, PoolState, StrategyEvent, Strategy, StrategyStats } from '../types'
import { fetchPosition, fetchPoolState, fetchRebalances, fetchStrategies, fetchStrategyStats } from '../api'
import { useAuth } from '../context/AuthContext'

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
function tokenLabel(address: string) {
  return TOKEN_LABELS[address.toLowerCase()] ?? address.slice(0, 6) + '…' + address.slice(-4)
}
function feeLabel(fee: number) { return (fee / 10000).toFixed(2) + '%' }
function shortHash(hash: string) { return hash.slice(0, 8) + '…' + hash.slice(-6) }
function tickToPrice(tick: number, d0: number, d1: number) {
  return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1)
}
function formatPrice(p: number) { return p.toLocaleString('en-US', { maximumFractionDigits: 2 }) }
function formatUsd(n: number, forceSign = false) {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  if (forceSign) return (n >= 0 ? '+' : '−') + s
  return n < 0 ? '−' + s : s
}
function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return `${Math.floor(d / 30)}mo ago`
}
function daysRunning(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000)
}

function computeEventFees(r: StrategyEvent): { feesUsd: number; gasUsd: number } | null {
  const d = r.rebalanceDetails
  if (!d || d.ethPriceUsd == null) return null
  const feesToken0 = d.feesCollectedToken0 ? Number(BigInt(d.feesCollectedToken0)) / 1e18 : 0
  const feesToken1 = d.feesCollectedToken1 ? Number(BigInt(d.feesCollectedToken1)) / 1e6 : 0
  const feesUsd = feesToken0 * d.ethPriceUsd + feesToken1
  const gasUsd = d.gasUsedWei ? (d.gasUsedWei / 1e18) * d.ethPriceUsd : 0
  return { feesUsd, gasUsd }
}

// ── Stat card ────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'pos' | 'neg'
}) {
  return (
    <div className="bg-white/60 backdrop-blur-sm border border-white/80 rounded-2xl p-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-gray-400">{label}</div>
      <div className={`text-[22px] font-bold tracking-tight mt-1.5 mono ${
        tone === 'pos' ? 'accent-text' : tone === 'neg' ? 'text-red-500' : 'text-gray-900'
      }`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

// ── Price range bar ──────────────────────────────────────────────────────────
function PriceRangeBar({ tick, tickLower, tickUpper, decimals0, decimals1 }: {
  tick: number; tickLower: number; tickUpper: number; decimals0: number; decimals1: number
}) {
  const inRange = tick >= tickLower && tick < tickUpper
  const pad = (tickUpper - tickLower) * 0.5
  const min = tickLower - pad, max = tickUpper + pad, total = max - min
  const loPct = ((tickLower - min) / total) * 100
  const hiPct = ((tickUpper - min) / total) * 100
  const curPct = Math.min(Math.max(((tick - min) / total) * 100, 0), 100)
  const lo = tickToPrice(tickLower, decimals0, decimals1)
  const hi = tickToPrice(tickUpper, decimals0, decimals1)
  const cur = tickToPrice(tick, decimals0, decimals1)

  return (
    <div className="mt-3">
      <div className="h-9 rounded-lg stripes relative overflow-hidden">
        <div
          className={`absolute top-0 bottom-0 border-y-2 ${inRange ? 'accent-bg accent-border' : 'bg-red-50 border-red-200'}`}
          style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-gray-900"
          style={{ left: `${curPct}%` }}
        />
      </div>
      <div className="flex justify-between mt-2 text-[11px] mono text-gray-400">
        <span>${formatPrice(lo)}</span>
        <span>current · ${formatPrice(cur)}</span>
        <span>${formatPrice(hi)}</span>
      </div>
    </div>
  )
}

// ── Onboarding ───────────────────────────────────────────────────────────────
function OnboardingState({ hasWallet }: { hasWallet: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 bg-white/60 backdrop-blur-sm rounded-2xl flex items-center justify-center mb-5 border border-white/80 shadow-sm">
        <span className="text-2xl font-bold text-gray-400">Δ</span>
      </div>
      <h2 className="text-lg font-bold text-gray-900 mb-2">Welcome to lagrangefi</h2>
      <p className="text-gray-500 text-sm max-w-xs mb-8">
        Automatically rebalances your Uniswap v3 ETH/USDC position to keep it in range.
      </p>
      <div className="flex flex-col items-center gap-3 w-full max-w-xs">
        <div className={`w-full flex items-center gap-4 rounded-2xl border p-4 ${
          hasWallet ? 'bg-emerald-50/60 border-emerald-200' : 'bg-white/60 backdrop-blur-sm border-white/80 shadow-sm'
        }`}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
            hasWallet ? 'bg-emerald-500 text-white' : 'bg-gray-900 text-white'
          }`}>
            {hasWallet ? '✓' : '1'}
          </div>
          <div className="text-left">
            <p className={`text-sm font-semibold ${hasWallet ? 'text-emerald-700' : 'text-gray-900'}`}>
              {hasWallet ? 'Wallet configured' : 'Add your wallet'}
            </p>
            {!hasWallet && <p className="text-xs text-gray-400">BIP39 mnemonic or private key</p>}
          </div>
          {!hasWallet && (
            <Link to="/profile" className="ml-auto bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              Go →
            </Link>
          )}
        </div>
        <div className={`w-full flex items-center gap-4 rounded-2xl border p-4 ${
          hasWallet ? 'bg-white/60 backdrop-blur-sm border-white/80 shadow-sm' : 'bg-gray-100/40 border-gray-200/60 opacity-60'
        }`}>
          <div className="w-8 h-8 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold shrink-0">2</div>
          <div className="text-left">
            <p className="text-sm font-semibold text-gray-900">Create a strategy</p>
            <p className="text-xs text-gray-400">Deposit ETH + USDC, set range width</p>
          </div>
          {hasWallet && (
            <Link to="/strategies" className="ml-auto bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">
              Go →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { user } = useAuth()

  const [position,   setPosition]   = useState<Position | null>(null)
  const [poolState,  setPoolState]  = useState<PoolState | null>(null)
  const [rebalances, setRebalances] = useState<StrategyEvent[]>([])
  const [strategy,   setStrategy]   = useState<Strategy | null>(null)
  const [stats,      setStats]      = useState<StrategyStats | null>(null)

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshing,  setRefreshing]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [noStrategy,  setNoStrategy]  = useState(false)

  const fetchAll = useCallback(async () => {
    setRefreshing(true)
    try {
      const strategies = await fetchStrategies()
      const active = strategies.find(s => s.status === 'ACTIVE') ?? null
      setStrategy(active)

      if (!active) {
        setNoStrategy(true)
        setRefreshing(false)
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
      setError(null)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch data'
      if (msg !== 'Unauthorized') setError(msg)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [fetchAll])

  const inRange = poolState && position
    ? poolState.tick >= position.tickLower && poolState.tick < position.tickUpper
    : null

  const rebalanceEvents = rebalances.filter(r => r.action === 'REBALANCE')

  const pairLabel = strategy
    ? `${tokenLabel(strategy.token0)}/${tokenLabel(strategy.token1)} · ${feeLabel(strategy.fee)}`
    : 'Uniswap auto-rebalance'

  if (noStrategy) {
    return (
      <div>
        <header className="mb-6 flex items-end justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">lagrangefi</div>
            <h1 className="text-[26px] font-bold tracking-tight mt-1 text-gray-900">Uniswap auto-rebalance</h1>
          </div>
        </header>
        <OnboardingState hasWallet={user?.hasWallet ?? false} />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <header className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-400">lagrangefi</div>
          <h1 className="text-[26px] font-bold tracking-tight mt-1 text-gray-900">{pairLabel}</h1>
        </div>
        <div className="flex items-center gap-3">
          {refreshing && (
            <span className="text-[11px] mono text-gray-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Refreshing
            </span>
          )}
          {lastUpdated && !refreshing && (
            <span className="text-[11px] mono text-gray-400">{lastUpdated.toLocaleTimeString()}</span>
          )}
          <div className="text-[11px] mono text-gray-500 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full accent-dot" />
            Live · Arbitrum
          </div>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="mb-5 flex items-center justify-between bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
          <button onClick={() => setError(null)} className="ml-3 text-red-400 hover:text-red-600 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <Stat
          label="Net P&L"
          value={stats ? formatUsd(stats.feesCollectedUsd - stats.gasCostUsd, true) : '—'}
          sub="fees − gas"
          tone={stats ? (stats.feesCollectedUsd - stats.gasCostUsd >= 0 ? 'pos' : 'neg') : undefined}
        />
        <Stat
          label="Fees collected"
          value={stats ? formatUsd(stats.feesCollectedUsd) : '—'}
          sub={strategy ? `${daysRunning(strategy.createdAt)}d running` : undefined}
        />
        <Stat
          label="Time in range"
          value={stats ? `${stats.timeInRangePct.toFixed(1)}%` : '—'}
          sub={stats ? `${stats.inRangeTicks} / ${stats.totalPollTicks} ticks` : undefined}
          tone={stats ? (stats.timeInRangePct >= 70 ? 'pos' : stats.timeInRangePct < 40 ? 'neg' : undefined) : undefined}
        />
        <Stat
          label="Gas spent"
          value={stats ? formatUsd(stats.gasCostUsd) : '—'}
          sub={stats ? `${stats.totalRebalances} rebalances` : undefined}
        />
      </div>

      {/* Active position card */}
      <div className="bg-white/60 backdrop-blur-sm border border-white/80 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-gray-400">Active position</div>
            <div className="text-[16px] font-bold text-gray-900 mt-0.5">{pairLabel}</div>
          </div>
          {inRange !== null && (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
              inRange ? 'accent-bg accent-text accent-border' : 'bg-red-50 text-red-700 border-red-200'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'accent-dot' : 'bg-red-500'}`} />
              {inRange ? 'In range' : 'Out of range'}
            </span>
          )}
        </div>

        {position && poolState ? (
          <PriceRangeBar
            tick={poolState.tick} tickLower={position.tickLower} tickUpper={position.tickUpper}
            decimals0={poolState.decimals0} decimals1={poolState.decimals1}
          />
        ) : (
          <div className="flex items-center gap-2 text-gray-400 text-sm py-6">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            Loading…
          </div>
        )}
      </div>

      {/* Recent rebalances */}
      <div className="bg-white/60 backdrop-blur-sm border border-white/80 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-gray-400">Recent rebalances</div>
          <Link to="/strategies" className="text-[11.5px] text-blue-600 hover:text-blue-700 font-medium">Full history →</Link>
        </div>

        {rebalanceEvents.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">No rebalances yet</p>
        ) : (
          <div>
            {rebalanceEvents.slice(0, 8).map((r, i) => {
              const ev = computeEventFees(r)
              return (
                <div key={r.id} className={`flex items-center justify-between py-2.5 ${i > 0 ? 'border-t border-black/5' : ''}`}>
                  <div className="flex items-center gap-3">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      r.status === 'success' ? 'accent-dot' : r.status === 'failed' ? 'bg-red-400' : 'bg-amber-400'
                    }`} />
                    <span className="text-[12.5px] text-gray-900 font-medium">Rebalance</span>
                    <span className="text-[11px] text-gray-400 mono">{relativeTime(r.triggeredAt)}</span>
                  </div>
                  <div className="flex items-center gap-4 text-[12px] mono text-gray-500">
                    {ev ? (
                      <>
                        <span className="accent-text">{formatUsd(ev.feesUsd, true)}</span>
                        <span>−{formatUsd(ev.gasUsd)}</span>
                      </>
                    ) : r.errorMessage ? (
                      <span className="text-red-400 text-[11px]">{r.errorMessage}</span>
                    ) : null}
                    {r.transactions?.[0]?.txHash && (
                      <a
                        href={`https://arbiscan.io/tx/${r.transactions[0].txHash}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
                      >
                        {shortHash(r.transactions[0].txHash)}
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
