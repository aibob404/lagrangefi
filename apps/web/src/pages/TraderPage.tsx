import { useState, useEffect, useCallback } from 'react'
import {
  fetchTraderStatus, fetchTraderSettingsInfo, saveTraderSettings, startTrader, stopTrader,
  startBacktest, pollBacktest,
} from '../api'
import type { TraderStatus, BacktestReport } from '../types'

// ── Tiny icon helpers ─────────────────────────────────────────────────────────
type IconProps = React.SVGProps<SVGSVGElement>
const icon = (path: React.ReactNode) => ({ width = 16, height = 16, ...rest }: IconProps) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {path}
  </svg>
)
const IconPlay     = icon(<><polygon points="5 3 19 12 5 21 5 3"/></>)
const IconStop     = icon(<><rect x="3" y="3" width="18" height="18" rx="2"/></>)
const IconLoader   = icon(<><path d="M21 12a9 9 0 1 1-6.219-8.56"/></>)
const IconCheck    = icon(<><polyline points="20 6 9 17 4 12"/></>)
const IconActivity = icon(<><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>)
const IconSettings = icon(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82V9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>)
const IconChart    = icon(<><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></>)

// ── Reusable sub-components ───────────────────────────────────────────────────

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white/70 backdrop-blur-xl rounded-2xl border border-white/80 shadow-sm p-5 ${className}`}>
      {children}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-[12px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">{children}</label>
}

function Input({ ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-xl border border-black/10 bg-white/60 px-3 py-2 text-[13.5px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black/10 transition"
    />
  )
}

function Btn({
  children, onClick, variant = 'primary', disabled = false, loading = false, className = ''
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  loading?: boolean
  className?: string
}) {
  const base = 'flex items-center gap-2 rounded-xl px-4 py-2 text-[13.5px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed'
  const variants = {
    primary: 'bg-gray-900 text-white hover:bg-gray-800 shadow-sm',
    danger:  'bg-red-600 text-white hover:bg-red-700 shadow-sm',
    ghost:   'bg-white/60 border border-black/10 text-gray-700 hover:bg-white/90',
  }
  return (
    <button onClick={onClick} disabled={disabled || loading} className={`${base} ${variants[variant]} ${className}`}>
      {loading && <IconLoader width={14} height={14} className="animate-spin" />}
      {children}
    </button>
  )
}

function RegimeBadge({ label }: { label: string }) {
  const colours: Record<string, string> = {
    STRONG_BULL: 'bg-emerald-100 text-emerald-800',
    BULL:        'bg-green-100 text-green-800',
    NEUTRAL:     'bg-yellow-100 text-yellow-800',
    BEAR:        'bg-red-100 text-red-800',
    LOW:         'bg-blue-100 text-blue-800',
    NORMAL:      'bg-slate-100 text-slate-700',
    ELEVATED:    'bg-amber-100 text-amber-800',
    HIGH:        'bg-orange-100 text-orange-800',
    EXTREME:     'bg-red-200 text-red-900',
    CRISIS:      'bg-red-300 text-red-950',
    UNKNOWN:     'bg-gray-100 text-gray-500',
  }
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${colours[label] ?? colours.UNKNOWN}`}>
      {label.replace('_', ' ')}
    </span>
  )
}

function StatRow({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-black/5 last:border-0">
      <span className="text-[12.5px] text-gray-500">{label}</span>
      <span className={`text-[13px] font-semibold tabular-nums ${accent ? 'text-emerald-600' : 'text-gray-900'}`}>{value}</span>
    </div>
  )
}

// ── Tab: Settings ─────────────────────────────────────────────────────────────

function SettingsTab() {
  const [form, setForm] = useState({
    alpacaApiKey: '', alpacaApiSecret: '',
    paper: true, startingEquity: 100000, riskPct: 0.005,
  })
  const [keySet, setKeySet] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchTraderSettingsInfo().then(info => {
      if (!info) return
      setKeySet(info.alpacaKeySet)
      setForm(f => ({ ...f, paper: info.paper, startingEquity: info.startingEquity, riskPct: info.riskPct }))
    })
  }, [])

  function set(key: string, value: string | boolean | number) {
    setForm(f => ({ ...f, [key]: value }))
    setSaved(false)
  }

  async function handleSave() {
    setSaving(true); setError('')
    try {
      await saveTraderSettings(form)
      setSaved(true)
      setKeySet(form.alpacaApiKey.trim() !== '' || keySet)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5 max-w-lg">
      <Card>
        <h3 className="text-[13px] font-bold text-gray-700 mb-4">Alpaca Markets</h3>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>API Key</Label>
              {keySet && <span className="text-[11px] text-emerald-600 font-medium">✓ saved</span>}
            </div>
            <Input type="text"
              placeholder={keySet ? 'Leave blank to keep existing key' : 'PKXXXXX...'}
              value={form.alpacaApiKey}
              onChange={e => set('alpacaApiKey', e.target.value)} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>API Secret</Label>
              {keySet && <span className="text-[11px] text-emerald-600 font-medium">✓ saved</span>}
            </div>
            <Input type="password"
              placeholder={keySet ? 'Leave blank to keep existing secret' : '••••••••'}
              value={form.alpacaApiSecret}
              onChange={e => set('alpacaApiSecret', e.target.value)} />
          </div>
          <div className="flex items-center gap-3 pt-1">
            <input type="checkbox" id="paper" checked={form.paper}
              onChange={e => set('paper', e.target.checked)}
              className="w-4 h-4 rounded accent-gray-900 cursor-pointer" />
            <label htmlFor="paper" className="text-[13px] text-gray-700 cursor-pointer">
              Paper trading mode <span className="text-gray-400">(recommended for testing)</span>
            </label>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-[13px] font-bold text-gray-700 mb-4">Risk parameters</h3>
        <div className="space-y-3">
          <div>
            <Label>Starting equity ($)</Label>
            <Input type="number" min={1000} step={1000} value={form.startingEquity}
              onChange={e => set('startingEquity', Number(e.target.value))} />
          </div>
          <div>
            <Label>Risk per trade (%)</Label>
            <Input type="number" min={0.1} max={2} step={0.1} value={form.riskPct * 100}
              onChange={e => set('riskPct', Number(e.target.value) / 100)} />
            <p className="text-[11.5px] text-gray-400 mt-1">
              Industry standard: 0.25–1.0%. Current: {(form.riskPct * 100).toFixed(2)}%
            </p>
          </div>
        </div>
      </Card>

      {error && <p className="text-[13px] text-red-600 bg-red-50 rounded-xl px-4 py-2">{error}</p>}

      <Btn onClick={handleSave} loading={saving}>
        {saved ? <><IconCheck width={14} height={14} /> Saved</> : 'Save credentials'}
      </Btn>
    </div>
  )
}

// ── Tab: Live ─────────────────────────────────────────────────────────────────

function LiveTab() {
  const [status, setStatus] = useState<TraderStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const s = await fetchTraderStatus()
      setStatus(s)
      setError('')
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  async function handleStart() {
    setLoading(true)
    try { await startTrader(); await refresh() }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleStop() {
    setLoading(true)
    try { await stopTrader(); await refresh() }
    catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div className="space-y-5 max-w-xl">
      {error && <p className="text-[13px] text-red-600 bg-red-50 rounded-xl px-4 py-2">{error}</p>}

      {/* Controls */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`w-2.5 h-2.5 rounded-full ${status?.running ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'}`} />
            <span className="text-[13.5px] font-semibold text-gray-800">
              {status?.running ? 'Live trading running' : 'Stopped'}
            </span>
          </div>
          {status?.running
            ? <Btn variant="danger" onClick={handleStop} loading={loading}>
                <IconStop width={14} height={14} /> Stop
              </Btn>
            : <Btn variant="primary" onClick={handleStart} loading={loading}>
                <IconPlay width={14} height={14} /> Start
              </Btn>
          }
        </div>
      </Card>

      {/* Regime */}
      {status && (
        <>
          <Card>
            <h3 className="text-[12px] font-bold text-gray-500 uppercase tracking-wider mb-3">Regime</h3>
            <div className="flex flex-wrap gap-3">
              <div>
                <p className="text-[11px] text-gray-400 mb-1">Macro</p>
                <RegimeBadge label={status.macroRegime} />
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-1">VIX</p>
                <RegimeBadge label={status.vixRegime} />
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-1">Position</p>
                <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${status.hasOpenPosition ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-500'}`}>
                  {status.hasOpenPosition ? 'OPEN' : 'FLAT'}
                </span>
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="text-[12px] font-bold text-gray-500 uppercase tracking-wider mb-3">Account</h3>
            <StatRow label="Equity" value={`$${status.accountEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
            <StatRow label="Daily P&L" value={`${status.dailyPnl >= 0 ? '+' : ''}$${status.dailyPnl.toFixed(2)}`} accent={status.dailyPnl > 0} />
          </Card>

          <Card>
            <h3 className="text-[12px] font-bold text-gray-500 uppercase tracking-wider mb-2">Last signal</h3>
            <p className="text-[12.5px] text-gray-600 font-mono leading-relaxed">{status.lastSignalReason}</p>
          </Card>
        </>
      )}
    </div>
  )
}

// ── Tab: Backtest ─────────────────────────────────────────────────────────────

function BacktestTab() {
  const [startDate, setStartDate] = useState('2021-01-01')
  const [endDate, setEndDate]     = useState('2024-12-31')
  const [running, setRunning]     = useState(false)
  const [jobId, setJobId]         = useState<string | null>(null)
  const [progress, setProgress]   = useState('')
  const [report, setReport]       = useState<BacktestReport | null>(null)
  const [error, setError]         = useState('')

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const id = setInterval(async () => {
      if (cancelled) return
      try {
        const s = await pollBacktest(jobId)
        if (cancelled) return
        setProgress(s.progress)
        if (s.status === 'done') {
          setReport(s.result!)
          setRunning(false)
          setJobId(null)
        } else if (s.status === 'error') {
          setError(s.error ?? 'Backtest failed')
          setRunning(false)
          setJobId(null)
        }
      } catch (e: any) {
        if (!cancelled) { setError(e.message); setRunning(false); setJobId(null) }
      }
    }, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [jobId])

  async function handleRun() {
    setRunning(true); setError(''); setReport(null); setProgress('Starting...')
    try {
      const { jobId: id } = await startBacktest(startDate, endDate)
      setJobId(id)
    } catch (e: any) {
      setError(e.message)
      setRunning(false)
    }
  }

  const fmt = (n: number, decimals = 2) => n.toFixed(decimals)
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`

  return (
    <div className="space-y-5 max-w-xl">
      <Card>
        <h3 className="text-[13px] font-bold text-gray-700 mb-4">Date range</h3>
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[140px]">
            <Label>Start date</Label>
            <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[140px]">
            <Label>End date</Label>
            <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </div>
        </div>
        <p className="text-[11.5px] text-gray-400 mt-3">
          Tip: use at least 3 years to cover multiple regimes. Fetches 5-min Alpaca data — allow 1–5 min for large ranges.
        </p>
      </Card>

      <Btn onClick={handleRun} loading={running} disabled={running}>
        <IconChart width={14} height={14} />
        {running ? 'Running…' : 'Run backtest'}
      </Btn>

      {running && progress && (
        <p className="text-[12.5px] text-gray-500 font-mono bg-gray-50 rounded-xl px-4 py-2">{progress}</p>
      )}

      {error && <p className="text-[13px] text-red-600 bg-red-50 rounded-xl px-4 py-2">{error}</p>}

      {report && (
        <Card>
          <h3 className="text-[12px] font-bold text-gray-500 uppercase tracking-wider mb-3">Results</h3>

          {/* Summary metrics grid */}
          <div className="grid grid-cols-2 gap-x-6">
            <StatRow label="Total trades"      value={report.totalTrades} />
            <StatRow label="Win rate"          value={pct(report.winRate)} />
            <StatRow label="Profit factor"     value={fmt(report.profitFactor)} />
            <StatRow label="Sharpe ratio"      value={fmt(report.sharpe)} />
            <StatRow label="Sortino ratio"     value={fmt(report.sortino)} />
            <StatRow label="Max drawdown"      value={pct(report.maxDrawdownPct)} />
            <StatRow label="Net return"        value={pct(report.netReturnPct)}    accent={report.netReturnPct > 0} />
            <StatRow label="Annual. return"    value={pct(report.annualisedReturnPct)} accent={report.annualisedReturnPct > 0} />
            <StatRow label="Avg hold"          value={`${fmt(report.avgHoldMinutes, 0)} min`} />
            <StatRow label="Trades / week"     value={fmt(report.tradesPerWeek, 1)} />
          </div>

          {/* Quality gauge strip */}
          <div className="mt-4 pt-4 border-t border-black/5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Quick assessment</p>
            <div className="flex flex-wrap gap-2">
              {report.sharpe >= 1.0 && <Tag color="green">Sharpe ≥ 1.0</Tag>}
              {report.sharpe < 0.6  && <Tag color="red">Low Sharpe</Tag>}
              {report.maxDrawdownPct <= 0.15 && <Tag color="green">DD within limit</Tag>}
              {report.maxDrawdownPct > 0.15  && <Tag color="red">Excessive DD</Tag>}
              {report.profitFactor >= 1.4 && <Tag color="green">PF ≥ 1.4</Tag>}
              {report.profitFactor < 1.0  && <Tag color="red">PF &lt; 1.0</Tag>}
              {report.winRate >= 0.40 && report.winRate <= 0.65 && <Tag color="green">Healthy win rate</Tag>}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

function Tag({ children, color }: { children: React.ReactNode; color: 'green' | 'red' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
      color === 'green' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'
    }`}>
      {color === 'green' ? <IconCheck width={10} height={10} /> : null}
      {children}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = 'settings' | 'live' | 'backtest'

export default function TraderPage() {
  const [tab, setTab] = useState<Tab>('live')

  const tabs: { id: Tab; label: string; icon: typeof IconActivity }[] = [
    { id: 'live',     label: 'Live',     icon: IconActivity },
    { id: 'backtest', label: 'Backtest', icon: IconChart },
    { id: 'settings', label: 'Settings', icon: IconSettings },
  ]

  return (
    <div>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-[22px] font-bold tracking-tight text-gray-900">SPY Trader</h1>
        <p className="text-[13px] text-gray-500 mt-1">
          Multi-layer ORB algorithm · Macro regime · VIX term structure · 14-gate checklist
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-white/60 backdrop-blur rounded-2xl border border-black/5 p-1 w-fit mb-6">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={[
              'flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold transition-all',
              tab === id
                ? 'bg-white shadow-sm text-gray-900'
                : 'text-gray-500 hover:text-gray-800',
            ].join(' ')}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'live'     && <LiveTab />}
      {tab === 'backtest' && <BacktestTab />}
    </div>
  )
}
