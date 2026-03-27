import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import type { Position, PoolState, RebalanceEvent, Strategy, StrategyStats } from '../types'
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
function formatUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function daysRunning(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000)
}

// Compute current unclaimed LP fees in USD from position tokensOwed
function computeUnclaimedFees(position: Position, ethPrice: number): { weth: number; usdc: number; usd: number } | null {
  if (!position.tokensOwed0 || !position.tokensOwed1) return null
  const weth = Number(BigInt(position.tokensOwed0)) / 1e18
  const usdc = Number(BigInt(position.tokensOwed1)) / 1e6
  return { weth, usdc, usd: weth * ethPrice + usdc }
}

// Compute net fees in USD using pool price (token1/token0 = USDC/WETH)
function computeNetFees(stats: StrategyStats, ethPrice: number, _token0: string, token1: string) {
  const t1Label = tokenLabel(token1)
  const isStableToken1 = t1Label.includes('USDC')
  if (!isStableToken1) return null // can't compute without knowing stable

  const feesToken0Eth = Number(BigInt(stats.feesCollectedToken0)) / 1e18  // WETH
  const feesToken1Usd = Number(BigInt(stats.feesCollectedToken1)) / 1e6   // USDC
  const gasEth = Number(BigInt(stats.gasCostWei)) / 1e18

  const feesUsd = feesToken1Usd + feesToken0Eth * ethPrice
  const gasUsd = gasEth * ethPrice
  const netUsd = feesUsd - gasUsd
  return { feesUsd, gasUsd, netUsd }
}

function MetricCard({
  label, value, sub, accent, note,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: 'green' | 'red' | 'blue' | 'amber'; note?: string
}) {
  const color =
    accent === 'green' ? 'text-emerald-600' :
    accent === 'red'   ? 'text-red-500' :
    accent === 'blue'  ? 'text-blue-600' :
    accent === 'amber' ? 'text-amber-500' :
    'text-gray-900'
  return (
    <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-3xl font-bold tracking-tight ${color}`}>{value}</p>
      {sub  && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
      {note && <p className="text-xs text-gray-400 mt-0.5 italic">{note}</p>}
    </div>
  )
}

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
    <div className="mt-2">
      <div className="flex justify-between text-xs text-gray-400 mb-2">
        <span>${formatPrice(lo)}</span>
        <span className="font-medium text-gray-700">Current: ${formatPrice(cur)}</span>
        <span>${formatPrice(hi)}</span>
      </div>
      <div className="relative h-3 bg-gray-100 rounded-full">
        <div className={`absolute h-full rounded-full ${inRange ? 'bg-emerald-200' : 'bg-red-200'}`}
          style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }} />
        <div className={`absolute top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full ${inRange ? 'bg-emerald-500' : 'bg-red-500'}`}
          style={{ left: `${curPct}%` }} />
      </div>
      <div className="flex justify-between text-xs mt-1.5">
        <span className="text-gray-400">Lower bound</span>
        <span className={`font-semibold ${inRange ? 'text-emerald-600' : 'text-red-500'}`}>
          {inRange ? 'In Range' : 'Out of Range'}
        </span>
        <span className="text-gray-400">Upper bound</span>
      </div>
    </div>
  )
}

const STATUS_PILL: Record<string, string> = {
  success: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  failed:  'bg-red-50 text-red-700 border border-red-200',
  pending: 'bg-amber-50 text-amber-700 border border-amber-200',
}

// ── Onboarding empty states ──────────────────────────────────────────────────
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
        {/* Step 1 */}
        <div className={`w-full flex items-center gap-4 rounded-2xl border p-4 ${
          hasWallet
            ? 'bg-emerald-50/60 border-emerald-200'
            : 'bg-white/60 backdrop-blur-sm border-white/80 shadow-sm'
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

        {/* Step 2 */}
        <div className={`w-full flex items-center gap-4 rounded-2xl border p-4 ${
          hasWallet
            ? 'bg-white/60 backdrop-blur-sm border-white/80 shadow-sm'
            : 'bg-gray-100/40 border-gray-200/60 opacity-60'
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
  const [rebalances, setRebalances] = useState<RebalanceEvent[]>([])
  const [strategy,   setStrategy]   = useState<Strategy | null>(null)
  const [stats,      setStats]      = useState<StrategyStats | null>(null)

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshing,  setRefreshing]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [noStrategy,  setNoStrategy]  = useState(false)

  const fetchAll = useCallback(async () => {
    setRefreshing(true)
    try {
      // Find active strategy first
      const strategies = await fetchStrategies()
      const active = strategies.find(s => s.status === 'active') ?? null
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

  const ethPrice = poolState ? parseFloat(poolState.price) : 0
  const fees = stats && strategy
    ? computeNetFees(stats, ethPrice, strategy.token0, strategy.token1)
    : null
  const unclaimedFees = position ? computeUnclaimedFees(position, ethPrice) : null

  const successCount = rebalances.filter(r => r.status === 'success').length
  const failedCount  = rebalances.filter(r => r.status === 'failed').length
  const totalFromStats = stats?.totalRebalances ?? (successCount + failedCount)
  const successRate = totalFromStats > 0
    ? Math.round((successCount / Math.max(successCount + failedCount, 1)) * 100)
    : null

  const pieData = [
    ...(successCount > 0 ? [{ name: 'Success', value: successCount }] : []),
    ...(failedCount  > 0 ? [{ name: 'Failed',  value: failedCount  }] : []),
    ...(successCount + failedCount === 0 ? [{ name: 'No data', value: 1 }] : []),
  ]
  const PIE_COLORS = successCount + failedCount === 0 ? ['#e5e7eb'] : ['#10b981', '#ef4444']

  // ── Onboarding state ──────────────────────────────────────────────────────
  if (noStrategy) {
    return (
      <div>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Uniswap v3 · Arbitrum</p>
        </div>
        <OnboardingState hasWallet={user?.hasWallet ?? false} />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {strategy ? `${strategy.name} · ${tokenLabel(strategy.token0)}/${tokenLabel(strategy.token1)} · ${feeLabel(strategy.fee)}` : 'Uniswap v3 · Arbitrum'}
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {refreshing && (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Refreshing
            </span>
          )}
          {lastUpdated && !refreshing && (
            <span className="text-xs text-gray-400">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

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

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
        <MetricCard
          label="ETH Price"
          value={poolState ? `$${Math.round(parseFloat(poolState.price)).toLocaleString()}` : '—'}
          sub="USDC per WETH"
          accent="blue"
        />
        <MetricCard
          label="Unclaimed Fees"
          value={unclaimedFees ? formatUsd(unclaimedFees.usd) : '—'}
          sub={unclaimedFees
            ? `${unclaimedFees.weth.toFixed(6)} WETH · ${unclaimedFees.usdc.toFixed(2)} USDC`
            : 'accrued in active LP'}
          accent={unclaimedFees && unclaimedFees.usd > 0 ? 'green' : undefined}
        />
        <MetricCard
          label="Net Fees"
          value={fees ? formatUsd(fees.netUsd) : '—'}
          sub={fees ? `${formatUsd(fees.feesUsd)} earned · ${formatUsd(fees.gasUsd)} gas` : 'fees minus gas'}
          accent={fees ? (fees.netUsd >= 0 ? 'green' : 'red') : undefined}
        />
        <MetricCard
          label="Time in Range"
          value={stats ? `${stats.timeInRangePct.toFixed(1)}%` : '—'}
          sub={strategy ? `${daysRunning(strategy.createdAt)}d running` : undefined}
          accent={stats ? (stats.timeInRangePct >= 70 ? 'green' : stats.timeInRangePct >= 40 ? 'amber' : 'red') : undefined}
        />
        <MetricCard
          label="Rebalances"
          value={stats?.totalRebalances ?? rebalances.length}
          sub={successRate !== null ? `${successRate}% success rate` : 'total events'}
          accent={successRate !== null ? (successRate >= 80 ? 'green' : successRate >= 50 ? 'amber' : 'red') : undefined}
        />
      </div>

      {/* Status + position */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {/* Position & Pool */}
        <div className="md:col-span-2 bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Position & Pool</h2>
            {inRange !== null && (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                inRange
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                {inRange ? 'In Range' : 'Out of Range'}
              </span>
            )}
          </div>

          {position && poolState ? (
            <>
              <div className="grid grid-cols-2 gap-x-8 gap-y-0">
                {[
                  ['Token ID',  `#${position.tokenId}`],
                  ['Pair',      `${tokenLabel(position.token0)} / ${tokenLabel(position.token1)}`],
                  ['Fee tier',  feeLabel(position.fee)],
                  ['Pool price', `$${Number(poolState.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`],
                  ['Liquidity', BigInt(position.liquidity) > 0n ? 'Active' : 'Empty'],
                  ['Poll interval', strategy ? `${strategy.pollIntervalSeconds}s` : '—'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between items-center py-1.5 border-b border-gray-50">
                    <span className="text-xs text-gray-400">{label}</span>
                    <span className="text-xs font-medium text-gray-700 font-mono">{value}</span>
                  </div>
                ))}
              </div>
              <PriceRangeBar
                tick={poolState.tick} tickLower={position.tickLower} tickUpper={position.tickUpper}
                decimals0={poolState.decimals0} decimals1={poolState.decimals1}
              />
            </>
          ) : (
            <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Loading…
            </div>
          )}
        </div>

        {/* Success rate donut */}
        <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5 flex flex-col">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Success Rate</h2>
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="relative">
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={44} outerRadius={62}
                    startAngle={90} endAngle={-270} dataKey="value" strokeWidth={0}>
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v, n]}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-2xl font-bold text-gray-900">
                  {successRate !== null ? `${successRate}%` : '—'}
                </span>
                <span className="text-xs text-gray-400">success</span>
              </div>
            </div>
            <div className="flex gap-4 mt-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="text-gray-500">{successCount} ok</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                <span className="text-gray-500">{failedCount} failed</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent rebalances */}
      <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Recent Rebalances</h2>
          <Link to="/strategies" className="text-xs text-blue-600 hover:text-blue-700 font-medium">Full history →</Link>
        </div>

        {rebalances.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">No rebalances yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-100">
                  <th className="text-left pb-2.5 font-semibold">Time</th>
                  <th className="text-left pb-2.5 font-semibold">Status</th>
                  <th className="text-left pb-2.5 font-semibold">New Range</th>
                  <th className="text-left pb-2.5 font-semibold">Transaction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rebalances.slice(0, 10).map(r => (
                  <tr key={r.id} className="hover:bg-white/30 transition-colors">
                    <td className="py-2.5 text-gray-500 font-mono text-xs whitespace-nowrap">
                      {new Date(r.triggeredAt).toLocaleString()}
                    </td>
                    <td className="py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_PILL[r.status] ?? STATUS_PILL.pending}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2.5 text-gray-600 font-mono text-xs">
                      {r.newTickLower != null && poolState
                        ? `$${formatPrice(tickToPrice(r.newTickLower, poolState.decimals0, poolState.decimals1))} → $${formatPrice(tickToPrice(r.newTickUpper!, poolState.decimals0, poolState.decimals1))}`
                        : <span className="text-gray-400">{r.errorMessage ?? '—'}</span>}
                    </td>
                    <td className="py-2.5 text-xs">
                      {r.txHashes
                        ? JSON.parse(r.txHashes).slice(0, 1).map((h: string) => (
                          <a key={h} href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-700 font-mono underline underline-offset-2">
                            {shortHash(h)}
                          </a>
                        ))
                        : <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
