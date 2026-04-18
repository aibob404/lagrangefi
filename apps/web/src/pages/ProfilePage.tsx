import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchWalletStatus, fetchWalletBalances, saveWallet } from '../api'
import { useAuth } from '../context/AuthContext'

export default function ProfilePage() {
  const { user, setUser, logout } = useAuth()
  const navigate = useNavigate()

  const [hasWallet, setHasWallet] = useState(false)
  const [balances, setBalances] = useState<{ address: string; eth: string; usdc: string } | null>(null)
  const [balancesLoading, setBalancesLoading] = useState(false)

  const [phrase, setPhrase] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    fetchWalletStatus().then(r => {
      setHasWallet(r.hasWallet)
      if (r.hasWallet) loadBalances()
    })
  }, [])

  async function loadBalances() {
    setBalancesLoading(true)
    try {
      const b = await fetchWalletBalances()
      setBalances(b)
    } catch { /* optional */ }
    finally { setBalancesLoading(false) }
  }

  async function handleSaveWallet(e: FormEvent) {
    e.preventDefault()
    setSaveError(null)
    setSaveState('saving')
    try {
      await saveWallet(phrase)
      setHasWallet(true)
      setSaveState('saved')
      setPhrase('')
      if (user) setUser({ ...user, hasWallet: true })
      loadBalances()
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save wallet')
      setSaveState('error')
    }
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div>
      <div className="mb-7">
        <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Profile</h1>
        <p className="text-sm text-slate-400 mt-0.5">Account settings and wallet management</p>
      </div>

      <div className="max-w-xl space-y-4">

        {/* Account card */}
        <div className="bg-slate-800/70 backdrop-blur-md rounded-xl border border-slate-700 shadow-lg shadow-black/20 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4">Account</h2>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_20px_rgba(16,185,129,0.3)] flex items-center justify-center text-slate-950 text-lg font-bold shrink-0">
              {user?.username[0].toUpperCase()}
            </div>
            <div>
              <p className="text-base font-semibold text-slate-100">{user?.username}</p>
              <p className="text-xs text-slate-500 mt-0.5">Uniswap v3 · Arbitrum</p>
            </div>
          </div>
        </div>

        {/* Wallet card */}
        <div className="bg-slate-800/70 backdrop-blur-md rounded-xl border border-slate-700 shadow-lg shadow-black/20 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Hot Wallet</h2>
            {hasWallet && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Configured
              </span>
            )}
          </div>

          {/* Balances */}
          {hasWallet && (
            <div className="mb-5">
              {balancesLoading ? (
                <p className="text-xs text-slate-500">Loading balances…</p>
              ) : balances ? (
                <div className="bg-slate-700/60 border border-slate-600 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-slate-500">Address</span>
                    <span className="text-xs font-mono text-slate-300">
                      {balances.address.slice(0, 6)}…{balances.address.slice(-4)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-slate-500">ETH</span>
                    <span className="text-sm font-mono font-semibold text-slate-100">{Number(balances.eth).toFixed(6)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-slate-500">USDC</span>
                    <span className="text-sm font-mono font-semibold text-slate-100">
                      {Number(balances.usdc).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* Replace / set wallet form */}
          {saveState === 'saved' && (
            <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm rounded-lg px-4 py-3 mb-4">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Wallet saved successfully.
            </div>
          )}

          {saveState === 'error' && saveError && (
            <div className="flex items-center justify-between bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm rounded-lg px-4 py-3 mb-4">
              {saveError}
              <button onClick={() => setSaveState('idle')} className="ml-2 text-rose-400 hover:text-rose-300">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <form onSubmit={handleSaveWallet} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                {hasWallet ? 'Replace wallet phrase' : 'Wallet phrase'}
                <span className="text-slate-500 font-normal ml-1">(BIP39 mnemonic or 0x… private key)</span>
              </label>
              <textarea
                className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:bg-slate-700 transition-colors resize-none font-mono"
                value={phrase}
                onChange={e => setPhrase(e.target.value)}
                placeholder="word1 word2 word3 … word12"
                rows={3}
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                AES-256-GCM encrypted at rest · never returned to client
              </p>
            </div>
            <button
              type="submit"
              disabled={saveState === 'saving'}
              className="bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 disabled:hover:bg-emerald-400 text-slate-950 text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
            >
              {saveState === 'saving' ? 'Saving…' : hasWallet ? 'Replace wallet' : 'Save wallet'}
            </button>
          </form>
        </div>

        {/* Logout */}
        <div className="bg-slate-800/70 backdrop-blur-md rounded-xl border border-slate-700 shadow-lg shadow-black/20 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4">Session</h2>
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-300">Sign out of your account</p>
            <button
              onClick={handleLogout}
              className="text-sm font-medium text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 px-4 py-2 rounded-lg transition-colors"
            >
              Log out
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
