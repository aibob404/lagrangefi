import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchStrategies, startStrategy, createStrategy,
  pauseStrategy, resumeStrategy, stopStrategy,
  fetchStrategyStats, fetchStrategyRebalances,
  fetchPosition, fetchPoolState, fetchWalletBalances,
} from '../api'
import type { Strategy, StrategyStats, RebalanceEvent, Position, PoolState } from '../types'
import { useAuth } from '../context/AuthContext'

interface WalletBalances { address: string; eth: string; usdc: string }

const FEE_TIERS = [
  { value: 100,   label: '0.01%' },
  { value: 500,   label: '0.05%' },
  { value: 3000,  label: '0.30%' },
  { value: 10000, label: '1.00%' },
]

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
function tokenLabel(addr: string) {
  return TOKEN_LABELS[addr.toLowerCase()] ?? addr.slice(0, 6) + '…' + addr.slice(-4)
}
function feeLabel(fee: number) { return (fee / 10000).toFixed(2) + '%' }
function shortHash(h: string) { return h.slice(0, 8) + '…' + h.slice(-6) }
function tokenDecimals(addr: string) {
  return (TOKEN_LABELS[addr.toLowerCase()] ?? '').includes('USDC') ? 6 : 18
}
function tickToPrice(tick: number, d0: number, d1: number) {
  return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1)
}
function formatPrice(p: number) { return p.toLocaleString('en-US', { maximumFractionDigits: 2 }) }
function formatUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function weiToEth(wei: string) { return (Number(BigInt(wei)) / 1e18).toFixed(6) }
function formatRaw(amount: string, decimals: number, sigFigs = 6) {
  const n = BigInt(amount), d = 10n ** BigInt(decimals)
  const whole = n / d
  const frac = (n % d).toString().padStart(decimals, '0')
  // Show enough decimal places to have at least sigFigs significant figures
  const leadingZeros = frac.match(/^0*/)?.[0].length ?? 0
  const show = Math.max(sigFigs, leadingZeros + sigFigs)
  return `${whole}.${frac.slice(0, show)}`
}
/** Format a raw token amount with optional USD equivalent: "0.001234 WETH ($4.57)" */
function formatRawWithUsd(amount: string, decimals: number, label: string, ethPrice: number): string {
  const val = Number(BigInt(amount)) / Math.pow(10, decimals)
  const formatted = formatRaw(amount, decimals)
  if (label.includes('WETH') && ethPrice > 0) {
    const usd = val * ethPrice
    return `${formatted} ${label} (${formatUsd(usd)})`
  }
  if (label.includes('USDC')) {
    return `${formatted} ${label}`
  }
  return `${formatted} ${label}`
}
function daysRunning(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000)
}

function computeNetFees(stats: StrategyStats, ethPrice: number, _token0: string, token1: string) {
  if (!tokenLabel(token1).includes('USDC')) return null
  const feesToken0Eth = Number(BigInt(stats.feesCollectedToken0)) / 1e18
  const feesToken1Usd = Number(BigInt(stats.feesCollectedToken1)) / 1e6
  const feesUsd = feesToken1Usd + feesToken0Eth * ethPrice
  // Use historically-accurate gas cost in USD; fall back to current price if not yet populated
  const gasUsd = stats.gasCostUsd > 0
    ? stats.gasCostUsd
    : (Number(BigInt(stats.gasCostWei)) / 1e18) * ethPrice
  return { feesUsd, gasUsd, netUsd: feesUsd - gasUsd }
}

// ── Sub-components ──────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  active:  'bg-emerald-50 text-emerald-700 border border-emerald-200',
  paused:  'bg-amber-50 text-amber-700 border border-amber-200',
  stopped: 'bg-gray-100 text-gray-500 border border-gray-200',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLES[status] ?? STATUS_STYLES.stopped}`}>
      {status === 'active' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
      {status}
    </span>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-gray-100/60 last:border-0">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-xs font-medium text-gray-700 font-mono">{value}</span>
    </div>
  )
}

function MetricCard({ label, value, sub, accent }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode
  accent?: 'green' | 'red' | 'blue' | 'amber'
}) {
  const color =
    accent === 'green' ? 'text-emerald-600' :
    accent === 'red'   ? 'text-red-500' :
    accent === 'blue'  ? 'text-blue-600' :
    accent === 'amber' ? 'text-amber-500' :
    'text-gray-900'
  return (
    <div className="bg-white/40 border border-white/60 rounded-xl p-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-2xl font-bold tracking-tight ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
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
    <div className="mt-3">
      <div className="flex justify-between text-xs text-gray-400 mb-1.5">
        <span>${formatPrice(lo)}</span>
        <span className="font-medium text-gray-700">Now: ${formatPrice(cur)}</span>
        <span>${formatPrice(hi)}</span>
      </div>
      <div className="relative h-3 bg-gray-300 rounded-full">
        <div className={`absolute h-full rounded-full ${inRange ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ left: `${loPct}%`, width: `${hiPct - loPct}%` }} />
        <div className={`absolute top-1/2 -translate-y-1/2 w-1 h-5 rounded-full ${inRange ? 'bg-emerald-600' : 'bg-red-600'}`}
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

function rebalanceFeesUsd(r: RebalanceEvent, dec0: number, dec1: number, label0: string): number | null {
  if (!r.ethPriceUsd || !r.feesCollectedToken0 || !r.feesCollectedToken1) return null
  const ethPrice = parseFloat(r.ethPriceUsd)
  const fee0 = Number(BigInt(r.feesCollectedToken0)) / Math.pow(10, dec0)
  const fee1 = Number(BigInt(r.feesCollectedToken1)) / Math.pow(10, dec1)
  return label0.includes('WETH') ? fee0 * ethPrice + fee1 : fee1 * ethPrice + fee0
}

function positionUsd(token0raw: string, token1raw: string, dec0: number, dec1: number, label0: string, ethPrice: number): number {
  const t0 = Number(BigInt(token0raw)) / Math.pow(10, dec0)
  const t1 = Number(BigInt(token1raw)) / Math.pow(10, dec1)
  return label0.includes('WETH') ? t0 * ethPrice + t1 : t1 * ethPrice + t0
}

function RebalanceTable({ events, token0, token1 }: { events: RebalanceEvent[]; token0: string; token1: string }) {
  const dec0 = tokenDecimals(token0), dec1 = tokenDecimals(token1)
  const label0 = tokenLabel(token0), label1 = tokenLabel(token1)
  if (events.length === 0)
    return <p className="text-gray-400 text-sm text-center py-6">No rebalances yet</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 border-b border-gray-100">
            {['Time', 'Status', 'New Range', 'LP Fees', 'LP Value (start→end)', 'Gas', 'Tx'].map(h => (
              <th key={h} className="text-left pb-2.5 font-semibold pr-4">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {events.map(r => {
            const ethPrice = r.ethPriceUsd ? parseFloat(r.ethPriceUsd) : 0
            const feesUsd = rebalanceFeesUsd(r, dec0, dec1, label0)
            const hasLp = r.positionToken0Start && r.positionToken1Start && r.positionToken0End && r.positionToken1End && ethPrice > 0
            return (
              <tr key={r.id} className={`transition-colors ${r.status === 'failed' ? 'bg-red-50/40' : 'hover:bg-white/30'}`}>
                <td className="py-2.5 text-gray-500 font-mono whitespace-nowrap pr-4">
                  {new Date(r.triggeredAt).toLocaleString()}
                </td>
                <td className="py-2.5 pr-4">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                    r.status === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                    r.status === 'failed'  ? 'bg-red-50 text-red-700 border border-red-200' :
                    'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}>{r.status}</span>
                </td>
                <td className="py-2.5 text-gray-600 font-mono pr-4">
                  {r.newTickLower != null
                    ? `$${formatPrice(tickToPrice(r.newTickLower, dec0, dec1))} → $${formatPrice(tickToPrice(r.newTickUpper!, dec0, dec1))}`
                    : <span className="text-red-400">{r.errorMessage ?? '—'}</span>}
                </td>
                <td className="py-2.5 text-gray-600 font-mono pr-4">
                  {r.feesCollectedToken0 != null ? (
                    <div className="space-y-0.5">
                      <div>{formatRaw(r.feesCollectedToken0, dec0)} {label0}</div>
                      <div>{formatRaw(r.feesCollectedToken1 ?? '0', dec1)} {label1}</div>
                      {feesUsd != null && (
                        <div className="text-emerald-600 font-semibold">{formatUsd(feesUsd)}</div>
                      )}
                    </div>
                  ) : '—'}
                </td>
                <td className="py-2.5 text-gray-600 font-mono pr-4">
                  {hasLp ? (
                    <div className="space-y-0.5">
                      <div className="text-gray-400">{formatUsd(positionUsd(r.positionToken0Start!, r.positionToken1Start!, dec0, dec1, label0, ethPrice))}</div>
                      <div className="text-gray-500">↓</div>
                      <div>{formatUsd(positionUsd(r.positionToken0End!, r.positionToken1End!, dec0, dec1, label0, ethPrice))}</div>
                    </div>
                  ) : '—'}
                </td>
                <td className="py-2.5 text-gray-500 font-mono pr-4">
                  {r.gasCostWei != null ? (
                    <div className="space-y-0.5">
                      <div>{weiToEth(r.gasCostWei)} ETH</div>
                      {ethPrice > 0 && (
                        <div className="text-red-400">{formatUsd(Number(BigInt(r.gasCostWei)) / 1e18 * ethPrice)}</div>
                      )}
                    </div>
                  ) : '—'}
                </td>
                <td className="py-2.5">
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
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OnboardingState({ hasWallet }: { hasWallet: boolean }) {
  return (
    <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm flex flex-col items-center justify-center py-20 text-center">
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
          }`}>{hasWallet ? '✓' : '1'}</div>
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
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function StrategyPage() {
  const { user } = useAuth()

  const [strategies,    setStrategies]  = useState<Strategy[]>([])
  const [stats,         setStats]       = useState<Record<number, StrategyStats>>({})
  const [rebalances,    setRebalances]  = useState<Record<number, RebalanceEvent[]>>({})
  const [positions,     setPositions]   = useState<Record<number, Position>>({})
  const [poolStates,    setPoolStates]  = useState<Record<number, PoolState>>({})
  const [expandedId,    setExpandedId]  = useState<number | null>(null)
  const [tabMap,        setTabMap]      = useState<Record<number, 'overview' | 'history'>>({})
  const [confirmStopId, setConfirmStopId] = useState<number | null>(null)
  const [error,         setError]       = useState<string | null>(null)
  const [walletBalances, setWalletBalances] = useState<WalletBalances | null>(null)
  const [lastUpdated,   setLastUpdated] = useState<Date | null>(null)
  const [refreshing,    setRefreshing]  = useState(false)

  // Create form
  const [showCreate,    setShowCreate]   = useState(false)
  const [showAdvanced,  setShowAdvanced] = useState(false)
  const [createMode,    setCreateMode]   = useState<'mint' | 'register'>('mint')
  const [formState,     setFormState]    = useState<'form' | 'submitting' | 'success' | 'error'>('form')
  const [createName,    setCreateName]   = useState('')
  const [ethAmount,     setEthAmount]    = useState('')
  const [usdcAmount,    setUsdcAmount]   = useState('')
  const [feeTier,       setFeeTier]      = useState(500)
  const [createTokenId, setCreateTokenId] = useState('')
  const [createRange,   setCreateRange]  = useState(5)
  const [createSlippage, setCreateSlippage] = useState('0.5')
  const [createInterval, setCreateInterval] = useState('60')
  const [createError,   setCreateError]  = useState<string | null>(null)
  const [successData,   setSuccessData]  = useState<{ tokenId: string; txHashes: string[] } | null>(null)
  const balancesLoadedRef = useRef(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setStrategies(await fetchStrategies())
      setLastUpdated(new Date())
      setError(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load strategies'
      if (msg !== 'Unauthorized') setError(msg)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [load])

  async function loadBalances() {
    if (balancesLoadedRef.current) return
    balancesLoadedRef.current = true
    try { setWalletBalances(await fetchWalletBalances()) }
    catch { /* optional */ }
  }

  function openCreate() {
    setShowCreate(true); setFormState('form')
    setCreateError(null); setSuccessData(null)
    setShowAdvanced(false); setCreateMode('mint')
    loadBalances()
  }
  function closeCreate() {
    setShowCreate(false); setFormState('form')
    setCreateError(null); setSuccessData(null)
  }

  async function expandStrategy(id: number) {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (!tabMap[id]) setTabMap(prev => ({ ...prev, [id]: 'overview' }))
    const strategy = strategies.find(s => s.id === id)
    const isActive = strategy?.status === 'active'
    const [s, r, pos, pool] = await Promise.all([
      fetchStrategyStats(id),
      fetchStrategyRebalances(id),
      isActive ? fetchPosition().catch(() => null) : Promise.resolve(null),
      isActive ? fetchPoolState().catch(() => null) : Promise.resolve(null),
    ])
    setStats(prev => ({ ...prev, [id]: s }))
    setRebalances(prev => ({ ...prev, [id]: r }))
    if (pos)  setPositions(prev  => ({ ...prev, [id]: pos }))
    if (pool) setPoolStates(prev => ({ ...prev, [id]: pool }))
  }

  function setTab(id: number, tab: 'overview' | 'history') {
    setTabMap(prev => ({ ...prev, [id]: tab }))
  }

  async function handlePause(id: number)  { await pauseStrategy(id); load() }
  async function handleResume(id: number) {
    try { await resumeStrategy(id); load() }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to resume') }
  }
  async function handleStop(id: number) {
    await stopStrategy(id)
    setConfirmStopId(null); setExpandedId(null); load()
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault(); setCreateError(null); setFormState('submitting')
    try {
      if (createMode === 'mint') {
        const result = await startStrategy({
          name: createName, ethAmount, usdcAmount, feeTier,
          rangePercent: createRange / 100,
          slippageTolerance: parseFloat(createSlippage) / 100,
          pollIntervalSeconds: parseInt(createInterval, 10),
        })
        setSuccessData(result); setFormState('success')
        balancesLoadedRef.current = false; load()
      } else {
        await createStrategy({
          name: createName, tokenId: createTokenId,
          rangePercent: createRange / 100,
          slippageTolerance: parseFloat(createSlippage) / 100,
          pollIntervalSeconds: parseInt(createInterval, 10),
        })
        closeCreate(); balancesLoadedRef.current = false; load()
      }
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create strategy')
      setFormState('error')
    }
  }

  const hasActive = strategies.some(s => s.status === 'active')

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Strategies</h1>
          <p className="text-sm text-gray-500 mt-0.5">Uniswap v3 · Arbitrum</p>
        </div>
        <div className="flex items-center gap-3 mt-1">
          {refreshing ? (
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Refreshing
            </span>
          ) : lastUpdated ? (
            <span className="text-xs text-gray-400">Updated {lastUpdated.toLocaleTimeString()}</span>
          ) : null}
          <button
            onClick={openCreate}
            disabled={hasActive}
            title={hasActive ? 'Stop or pause your active strategy first' : undefined}
            className="bg-gray-900 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            + New strategy
          </button>
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

      {/* ── Create form ─────────────────────────────────────────────────────── */}
      {showCreate && !hasActive && (
        <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-6 mb-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-base font-semibold text-gray-900">New strategy</h2>
            <button onClick={closeCreate} className="text-gray-400 hover:text-gray-600 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {formState === 'success' && successData && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                <span className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-xs font-bold shrink-0">✓</span>
                <div>
                  <p className="text-sm font-semibold text-emerald-800">Strategy started!</p>
                  <p className="text-xs text-emerald-600 font-mono">Position NFT #{successData.tokenId}</p>
                </div>
              </div>
              {successData.txHashes.length > 0 && (
                <div className="bg-white/40 border border-white/60 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Transactions</p>
                  <div className="space-y-1.5">
                    {successData.txHashes.map((h, i) => (
                      <div key={h} className="flex items-center justify-between">
                        <span className="text-xs text-gray-400">Step {i + 1}</span>
                        <a href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:text-blue-700 font-mono underline underline-offset-2">
                          {shortHash(h)}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <button onClick={closeCreate} className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
                Close
              </button>
            </div>
          )}

          {formState !== 'success' && (
            <form onSubmit={handleCreate} className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Strategy name</label>
                <input type="text" placeholder="My ETH/USDC strategy" value={createName}
                  onChange={e => setCreateName(e.target.value)} required
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors" />
              </div>

              {walletBalances && (
                <div className="bg-blue-50/60 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700">
                  Wallet: <span className="font-mono font-medium">{walletBalances.address.slice(0, 8)}…</span>
                  <span className="ml-3 font-medium">{Number(walletBalances.eth).toFixed(4)} ETH</span>
                  <span className="ml-3 font-medium">{Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDC</span>
                </div>
              )}

              {createMode === 'mint' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between items-baseline mb-1.5">
                      <label className="text-xs font-medium text-gray-600">ETH amount</label>
                      {walletBalances && (
                        <button type="button" onClick={() => setEthAmount(Number(walletBalances.eth).toFixed(4))}
                          className="text-xs text-blue-600 hover:text-blue-700 font-mono">
                          Max {Number(walletBalances.eth).toFixed(4)}
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input type="number" min="0" step="0.0001" placeholder="0.0" value={ethAmount}
                        onChange={e => setEthAmount(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white pr-12" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">ETH</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between items-baseline mb-1.5">
                      <label className="text-xs font-medium text-gray-600">USDC amount</label>
                      {walletBalances && (
                        <button type="button" onClick={() => setUsdcAmount(Number(walletBalances.usdc).toFixed(2))}
                          className="text-xs text-blue-600 hover:text-blue-700 font-mono">
                          Max {Number(walletBalances.usdc).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <input type="number" min="0" step="1" placeholder="0.0" value={usdcAmount}
                        onChange={e => setUsdcAmount(e.target.value)}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white pr-14" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">USDC</span>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Fee tier</label>
                <div className="grid grid-cols-4 gap-2">
                  {FEE_TIERS.map(ft => (
                    <button key={ft.value} type="button" onClick={() => setFeeTier(ft.value)}
                      className={`py-2 rounded-xl text-xs font-semibold border transition-colors ${
                        feeTier === ft.value
                          ? 'bg-gray-900 border-gray-900 text-white'
                          : 'bg-white border-gray-200 text-gray-600 hover:border-gray-400'
                      }`}>
                      {ft.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">
                  Price range — <span className="text-gray-900 font-semibold">±{createRange}%</span> from current price
                </label>
                <input type="range" min="1" max="20" step="1" value={createRange}
                  onChange={e => setCreateRange(Number(e.target.value))}
                  className="w-full accent-gray-900" />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>1% tight</span><span>20% wide</span>
                </div>
              </div>

              <div>
                <button type="button" onClick={() => setShowAdvanced(v => !v)}
                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors">
                  <svg className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  Advanced settings
                </button>
                {showAdvanced && (
                  <div className="mt-3 space-y-4 bg-white/40 border border-white/60 rounded-xl p-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Slippage (%)</label>
                        <input type="number" step="0.01" min="0.01" max="5" value={createSlippage}
                          onChange={e => setCreateSlippage(e.target.value)} required
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Poll interval (s)</label>
                        <input type="number" min="30" max="3600" value={createInterval}
                          onChange={e => setCreateInterval(e.target.value)} required
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors" />
                      </div>
                    </div>
                    <div className="pt-2 border-t border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <input type="checkbox" id="useRegister" checked={createMode === 'register'}
                          onChange={e => setCreateMode(e.target.checked ? 'register' : 'mint')}
                          className="accent-gray-900" />
                        <label htmlFor="useRegister" className="text-xs font-medium text-gray-600">
                          Track existing position NFT instead
                        </label>
                      </div>
                      {createMode === 'register' && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1.5">Position token ID</label>
                          <input
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 font-mono focus:outline-none focus:border-blue-500 focus:bg-white transition-colors"
                            value={createTokenId} onChange={e => setCreateTokenId(e.target.value)}
                            placeholder="123456" required={createMode === 'register'} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-white/40 border border-white/60 rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Summary</p>
                {createMode === 'mint' ? (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Deposit</span>
                      <span className="text-gray-700 font-mono">{ethAmount || '0'} ETH + {usdcAmount || '0'} USDC</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Pool</span>
                      <span className="text-gray-700">WETH / USDC · {FEE_TIERS.find(f => f.value === feeTier)?.label}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Position NFT</span>
                    <span className="text-gray-700 font-mono">#{createTokenId || '—'}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Range</span>
                  <span className="text-gray-700">±{createRange}% around current price</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Auto-rebalance</span>
                  <span className="text-emerald-600 font-semibold">Enabled</span>
                </div>
              </div>

              {createError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{createError}</p>
              )}

              <div className="flex gap-2">
                <button type="submit" disabled={formState === 'submitting'}
                  className="bg-gray-900 hover:bg-gray-800 disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors">
                  {formState === 'submitting' ? 'Starting…' : createMode === 'mint' ? 'Start strategy' : 'Register strategy'}
                </button>
                <button type="button" onClick={closeCreate}
                  className="text-gray-600 hover:text-gray-900 text-sm font-medium px-4 py-2.5 rounded-xl border border-gray-200 hover:border-gray-300 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ── Strategy list ──────────────────────────────────────────────────── */}
      {strategies.length === 0 ? (
        <OnboardingState hasWallet={user?.hasWallet ?? false} />
      ) : (
        <div className="space-y-3">
          {strategies.map(s => {
            const pos      = positions[s.id]
            const pool     = poolStates[s.id]
            const st       = stats[s.id]
            const ethPrice = pool ? parseFloat(pool.price) : 0
            const fees     = st ? computeNetFees(st, ethPrice, s.token0, s.token1) : null
            const inRange  = pool && pos ? pool.tick >= pos.tickLower && pool.tick < pos.tickUpper : null
            const tab      = tabMap[s.id] ?? 'overview'

            return (
              <div key={s.id} className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm overflow-hidden">
                {/* Card header */}
                <div
                  className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-white/30 transition-colors"
                  onClick={() => expandStrategy(s.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusBadge status={s.status} />
                    <span className="font-semibold text-gray-900 truncate">{s.name}</span>
                    <span className="text-xs text-gray-400 font-mono shrink-0 hidden sm:inline">
                      {tokenLabel(s.token0)}/{tokenLabel(s.token1)} · {feeLabel(s.fee)} · #{s.currentTokenId}
                    </span>
                    {s.status !== 'stopped' && (
                      <span className="text-xs text-gray-400 shrink-0 hidden md:inline">
                        {daysRunning(s.createdAt)}d running
                      </span>
                    )}
                    {s.status === 'active' && inRange !== null && (
                      <span className={`hidden lg:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        inRange
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-red-50 text-red-700 border border-red-200'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                        {inRange ? 'In Range' : 'Out of Range'}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
                    {s.status === 'active' && (
                      <button onClick={() => handlePause(s.id)}
                        className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 px-3 py-1.5 rounded-lg transition-colors">
                        Pause
                      </button>
                    )}
                    {s.status === 'paused' && (
                      <button onClick={() => handleResume(s.id)}
                        className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-colors">
                        Resume
                      </button>
                    )}
                    {s.status !== 'stopped' && confirmStopId !== s.id && (
                      <button onClick={() => setConfirmStopId(s.id)}
                        className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors">
                        Stop
                      </button>
                    )}
                    {confirmStopId === s.id && (
                      <div className="flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
                        <span className="text-xs text-red-700 font-medium">Stop permanently?</span>
                        <button onClick={() => handleStop(s.id)}
                          className="text-xs font-bold text-white bg-red-600 hover:bg-red-700 px-2 py-0.5 rounded transition-colors">
                          Yes
                        </button>
                        <button onClick={() => setConfirmStopId(null)}
                          className="text-xs font-medium text-red-600 hover:text-red-800 px-1">
                          Cancel
                        </button>
                      </div>
                    )}
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${expandedId === s.id ? 'rotate-180' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>

                {/* Expanded */}
                {expandedId === s.id && (
                  <div className="border-t border-gray-100/60 px-5 py-4">
                    {/* Tabs */}
                    <div className="flex gap-1 bg-gray-200/50 rounded-xl p-1 w-fit mb-5">
                      {(['overview', 'history'] as const).map(t => (
                        <button key={t} onClick={() => setTab(s.id, t)}
                          className={`px-4 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                            tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                          }`}>
                          {t}
                        </button>
                      ))}
                    </div>

                    {/* Overview tab */}
                    {tab === 'overview' && (
                      <div className="space-y-4">
                        {/* Metric cards — shown once stats loaded */}
                        {st && (
                          <div className="grid grid-cols-3 gap-3">
                            <MetricCard
                              label="ETH Price"
                              value={pool ? `$${Math.round(ethPrice).toLocaleString()}` : '—'}
                              sub="USDC per WETH"
                              accent="blue"
                            />
                            <MetricCard
                              label="Net Fees"
                              value={fees ? formatUsd(fees.netUsd) : '—'}
                              sub={fees ? `${formatUsd(fees.feesUsd)} earned · ${formatUsd(fees.gasUsd)} gas` : undefined}
                              accent={fees ? (fees.netUsd >= 0 ? 'green' : 'red') : undefined}
                            />
                            <MetricCard
                              label="Time in Range"
                              value={`${st.timeInRangePct.toFixed(1)}%`}
                              sub={`${daysRunning(s.createdAt)}d · ${st.totalRebalances} rebalances`}
                              accent={st.timeInRangePct >= 70 ? 'green' : st.timeInRangePct >= 40 ? 'amber' : 'red'}
                            />
                          </div>
                        )}

                        {/* Position + Config */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Position */}
                          <div className="bg-white/40 border border-white/60 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-3">
                              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Position</h3>
                              {s.status === 'active' && inRange !== null && (
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                                  inRange
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : 'bg-red-50 text-red-700 border border-red-200'
                                }`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${inRange ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                                  {inRange ? 'In Range' : 'Out of Range'}
                                </span>
                              )}
                            </div>
                            {s.status !== 'active' ? (
                              <p className="text-xs text-gray-400 py-3">
                                Live position data is only available for active strategies.
                              </p>
                            ) : pos && pool ? (
                              <>
                                <InfoRow label="Token ID"   value={`#${pos.tokenId}`} />
                                <InfoRow label="Pool price" value={`$${Number(pool.price).toLocaleString('en-US', { maximumFractionDigits: 2 })}`} />
                                <InfoRow label="Liquidity"  value={BigInt(pos.liquidity) > 0n ? 'Active' : 'Empty'} />
                                <InfoRow label="Fee tier"   value={feeLabel(pos.fee)} />
                                <PriceRangeBar
                                  tick={pool.tick} tickLower={pos.tickLower} tickUpper={pos.tickUpper}
                                  decimals0={pool.decimals0} decimals1={pool.decimals1}
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

                          {/* Config */}
                          <div className="bg-white/40 border border-white/60 rounded-xl p-4">
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Config</h3>
                            <InfoRow label="Range"         value={`± ${(s.rangePercent * 100).toFixed(1)}%`} />
                            <InfoRow label="Slippage"      value={`${(s.slippageTolerance * 100).toFixed(2)}%`} />
                            <InfoRow label="Poll interval" value={`${s.pollIntervalSeconds}s`} />
                            <InfoRow label="Started"       value={new Date(s.createdAt).toLocaleDateString()} />
                            <InfoRow label="Running"       value={`${daysRunning(s.createdAt)} days`} />
                            {s.stoppedAt && <InfoRow label="Stopped" value={new Date(s.stoppedAt).toLocaleDateString()} />}
                            {st && st.totalRebalances >= 3 && st.avgRebalanceIntervalHours != null && (
                              <InfoRow label="Avg rebalance" value={`${st.avgRebalanceIntervalHours.toFixed(1)}h`} />
                            )}
                            {st && (
                              <>
                                <InfoRow label={`Fees ${tokenLabel(s.token0)}`} value={formatRawWithUsd(st.feesCollectedToken0, tokenDecimals(s.token0), tokenLabel(s.token0), ethPrice)} />
                                <InfoRow label={`Fees ${tokenLabel(s.token1)}`} value={formatRaw(st.feesCollectedToken1, tokenDecimals(s.token1))} />
                                <InfoRow label="Gas spent" value={`${weiToEth(st.gasCostWei)} ETH${st.gasCostUsd > 0 ? ` (${formatUsd(st.gasCostUsd)})` : ''}`} />
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* History tab */}
                    {tab === 'history' && (
                      <div className="bg-white/40 border border-white/60 rounded-xl p-4">
                        {rebalances[s.id] ? (
                          <RebalanceTable events={rebalances[s.id]} token0={s.token0} token1={s.token1} />
                        ) : (
                          <p className="text-gray-400 text-sm text-center py-4">Loading…</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
