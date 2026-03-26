import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchStrategies, createStrategy, pauseStrategy, resumeStrategy, stopStrategy,
  fetchStrategyStats, fetchStrategyRebalances,
} from '../api'
import type { Strategy, StrategyStats, RebalanceEvent } from '../types'

const TOKEN_LABELS: Record<string, string> = {
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e',
}
function tokenLabel(addr: string) {
  return TOKEN_LABELS[addr.toLowerCase()] ?? addr.slice(0, 6) + '...' + addr.slice(-4)
}
function feeLabel(fee: number) {
  return (fee / 10000).toFixed(2) + '%'
}
function shortHash(h: string) {
  return h.slice(0, 8) + '...' + h.slice(-6)
}
function weiToEth(wei: string): string {
  const n = BigInt(wei)
  const eth = Number(n) / 1e18
  return eth.toFixed(6)
}
function formatRawAmount(amount: string, decimals: number): string {
  const n = BigInt(amount)
  const d = 10n ** BigInt(decimals)
  const whole = n / d
  const frac = n % d
  return `${whole}.${frac.toString().padStart(decimals, '0').slice(0, 4)}`
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-emerald-500/20 text-emerald-400 ring-emerald-500/30',
    paused: 'bg-yellow-500/20 text-yellow-400 ring-yellow-500/30',
    stopped: 'bg-slate-500/20 text-slate-400 ring-slate-500/30',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${styles[status] ?? styles.stopped}`}>
      {status === 'active' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {status}
    </span>
  )
}

function StatsCard({ stats, token0, token1 }: { stats: StrategyStats; token0: string; token1: string }) {
  const t0Label = tokenLabel(token0)
  const t1Label = tokenLabel(token1)
  // USDC has 6 decimals, WETH 18 — heuristic: if "USDC" in label use 6 else 18
  const dec0 = t0Label.includes('USDC') ? 6 : 18
  const dec1 = t1Label.includes('USDC') ? 6 : 18

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Analytics</h3>
      <Row label="Rebalances" value={stats.totalRebalances} />
      <Row label="Time in range" value={`${stats.timeInRangePct.toFixed(1)}%`} />
      <Row label={`Fees (${t0Label})`} value={formatRawAmount(stats.feesCollectedToken0, dec0)} />
      <Row label={`Fees (${t1Label})`} value={formatRawAmount(stats.feesCollectedToken1, dec1)} />
      <Row label="Gas spent (ETH)" value={weiToEth(stats.gasCostWei)} />
      <Row
        label="Avg rebalance interval"
        value={stats.avgRebalanceIntervalHours != null ? `${stats.avgRebalanceIntervalHours.toFixed(1)}h` : '—'}
      />
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-slate-700/40 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-sm font-mono text-slate-200">{value}</span>
    </div>
  )
}

function RebalanceTable({ events }: { events: RebalanceEvent[] }) {
  if (events.length === 0) return <p className="text-slate-500 text-sm py-4 text-center">No rebalances yet</p>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-700">
            <th className="text-left pb-2 font-medium">Time</th>
            <th className="text-left pb-2 font-medium">Status</th>
            <th className="text-left pb-2 font-medium">New Range</th>
            <th className="text-left pb-2 font-medium">Fees (t0/t1)</th>
            <th className="text-left pb-2 font-medium">Tx</th>
          </tr>
        </thead>
        <tbody>
          {events.map(r => (
            <tr key={r.id} className="border-b border-slate-700/40 last:border-0">
              <td className="py-2 text-slate-400 font-mono text-xs">{new Date(r.triggeredAt).toLocaleString()}</td>
              <td className="py-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  r.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                  r.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                  'bg-yellow-500/20 text-yellow-400'
                }`}>{r.status}</span>
              </td>
              <td className="py-2 text-slate-300 font-mono text-xs">
                {r.newTickLower != null ? `${r.newTickLower} → ${r.newTickUpper}` : '—'}
              </td>
              <td className="py-2 text-slate-400 font-mono text-xs">
                {r.feesCollectedToken0 != null ? `${r.feesCollectedToken0} / ${r.feesCollectedToken1}` : '—'}
              </td>
              <td className="py-2 text-slate-400 font-mono text-xs">
                {r.txHashes
                  ? JSON.parse(r.txHashes).slice(0, 1).map((h: string) => (
                      <a key={h} href={`https://arbiscan.io/tx/${h}`} target="_blank" rel="noopener noreferrer"
                         className="text-blue-400 hover:text-blue-300 underline">{shortHash(h)}</a>
                    ))
                  : r.errorMessage ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function StrategyPage() {
  const navigate = useNavigate()
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [stats, setStats] = useState<Record<number, StrategyStats>>({})
  const [rebalances, setRebalances] = useState<Record<number, RebalanceEvent[]>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createTokenId, setCreateTokenId] = useState('')
  const [createRange, setCreateRange] = useState('5')
  const [createSlippage, setCreateSlippage] = useState('0.5')
  const [createInterval, setCreateInterval] = useState('60')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      const list = await fetchStrategies()
      setStrategies(list)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load strategies')
    }
  }

  async function expandStrategy(id: number, _token0: string, _token1: string) {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    const [s, r] = await Promise.all([
      fetchStrategyStats(id),
      fetchStrategyRebalances(id),
    ])
    setStats(prev => ({ ...prev, [id]: s }))
    setRebalances(prev => ({ ...prev, [id]: r }))
  }

  async function handlePause(id: number) {
    await pauseStrategy(id)
    load()
  }

  async function handleResume(id: number) {
    try {
      await resumeStrategy(id)
      load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to resume')
    }
  }

  async function handleStop(id: number) {
    if (!confirm('Stop this strategy permanently?')) return
    await stopStrategy(id)
    setExpandedId(null)
    load()
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setCreateError(null)
    setCreating(true)
    try {
      await createStrategy({
        name: createName,
        tokenId: createTokenId,
        rangePercent: parseFloat(createRange) / 100,
        slippageTolerance: parseFloat(createSlippage) / 100,
        pollIntervalSeconds: parseInt(createInterval, 10),
      })
      setShowCreate(false)
      setCreateName(''); setCreateTokenId(''); setCreateRange('5')
      setCreateSlippage('0.5'); setCreateInterval('60')
      load()
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create strategy')
    } finally {
      setCreating(false)
    }
  }

  const hasActive = strategies.some(s => s.status === 'active')

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Strategies</h1>
        {!hasActive && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            New strategy
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 mb-6 space-y-4">
          <h2 className="text-base font-semibold text-white">Create strategy</h2>
          {createError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-3 py-2">{createError}</div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Name</label>
              <input className="input w-full" value={createName} onChange={e => setCreateName(e.target.value)} placeholder="My ETH/USDC strategy" required />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Position token ID (NFT)</label>
              <input className="input w-full font-mono" value={createTokenId} onChange={e => setCreateTokenId(e.target.value)} placeholder="123456" required />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Range (%)</label>
              <input className="input w-full" type="number" step="0.1" min="0.1" max="50" value={createRange} onChange={e => setCreateRange(e.target.value)} required />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Slippage tolerance (%)</label>
              <input className="input w-full" type="number" step="0.01" min="0.01" max="5" value={createSlippage} onChange={e => setCreateSlippage(e.target.value)} required />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Poll interval (seconds)</label>
              <input className="input w-full" type="number" min="30" max="3600" value={createInterval} onChange={e => setCreateInterval(e.target.value)} required />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={creating} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-white text-sm px-4 py-2 rounded-lg border border-slate-700 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {strategies.length === 0 ? (
        <div className="text-center py-16 text-slate-500 text-sm">
          No strategies yet.{' '}
          <button className="text-blue-400 hover:text-blue-300" onClick={() => navigate('/wallet')}>
            Configure a wallet first
          </button>{' '}
          then create one.
        </div>
      ) : (
        <div className="space-y-4">
          {strategies.map(s => (
            <div key={s.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
              {/* Strategy header */}
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-slate-700/20 transition-colors"
                onClick={() => expandStrategy(s.id, s.token0, s.token1)}
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <span className="font-medium text-white">{s.name}</span>
                  <span className="text-xs text-slate-400 font-mono">
                    {tokenLabel(s.token0)}/{tokenLabel(s.token1)} · {feeLabel(s.fee)} · #{s.currentTokenId}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {s.status === 'active' && (
                    <button onClick={e => { e.stopPropagation(); handlePause(s.id) }}
                      className="text-xs text-yellow-400 hover:text-yellow-300 px-2 py-1 rounded border border-yellow-500/30 hover:border-yellow-400/50 transition-colors">
                      Pause
                    </button>
                  )}
                  {s.status === 'paused' && (
                    <button onClick={e => { e.stopPropagation(); handleResume(s.id) }}
                      className="text-xs text-emerald-400 hover:text-emerald-300 px-2 py-1 rounded border border-emerald-500/30 hover:border-emerald-400/50 transition-colors">
                      Resume
                    </button>
                  )}
                  {s.status !== 'stopped' && (
                    <button onClick={e => { e.stopPropagation(); handleStop(s.id) }}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/30 hover:border-red-400/50 transition-colors">
                      Stop
                    </button>
                  )}
                  <span className="text-slate-500 text-sm">{expandedId === s.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {expandedId === s.id && (
                <div className="border-t border-slate-700/50 px-5 py-4 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 space-y-2">
                      <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">Config</h3>
                      <Row label="Range" value={`± ${(s.rangePercent * 100).toFixed(1)}%`} />
                      <Row label="Slippage" value={`${(s.slippageTolerance * 100).toFixed(2)}%`} />
                      <Row label="Poll interval" value={`${s.pollIntervalSeconds}s`} />
                      <Row label="Started" value={new Date(s.createdAt).toLocaleDateString()} />
                      {s.stoppedAt && <Row label="Stopped" value={new Date(s.stoppedAt).toLocaleDateString()} />}
                    </div>

                    {stats[s.id] ? (
                      <StatsCard stats={stats[s.id]} token0={s.token0} token1={s.token1} />
                    ) : (
                      <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 flex items-center justify-center text-slate-500 text-sm">
                        Loading stats...
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-4">Rebalance History</h3>
                    {rebalances[s.id] ? (
                      <RebalanceTable events={rebalances[s.id]} />
                    ) : (
                      <p className="text-slate-500 text-sm text-center py-4">Loading...</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
