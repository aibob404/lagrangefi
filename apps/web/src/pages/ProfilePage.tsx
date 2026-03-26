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
        <h1 className="text-2xl font-bold text-gray-900">Profile</h1>
        <p className="text-sm text-gray-500 mt-0.5">Account settings and wallet management</p>
      </div>

      <div className="max-w-xl space-y-4">

        {/* Account card */}
        <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Account</h2>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gray-900 flex items-center justify-center text-white text-lg font-bold shrink-0">
              {user?.username[0].toUpperCase()}
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">{user?.username}</p>
              <p className="text-xs text-gray-400 mt-0.5">Uniswap v3 · Arbitrum</p>
            </div>
          </div>
        </div>

        {/* Wallet card */}
        <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Hot Wallet</h2>
            {hasWallet && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Configured
              </span>
            )}
          </div>

          {/* Balances */}
          {hasWallet && (
            <div className="mb-5">
              {balancesLoading ? (
                <p className="text-xs text-gray-400">Loading balances…</p>
              ) : balances ? (
                <div className="bg-white/40 border border-white/60 rounded-xl p-4 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">Address</span>
                    <span className="text-xs font-mono text-gray-600">
                      {balances.address.slice(0, 6)}…{balances.address.slice(-4)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">ETH</span>
                    <span className="text-sm font-mono font-semibold text-gray-900">{Number(balances.eth).toFixed(6)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-400">USDC</span>
                    <span className="text-sm font-mono font-semibold text-gray-900">
                      {Number(balances.usdc).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* Replace / set wallet form */}
          {saveState === 'saved' && (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-xl px-4 py-3 mb-4">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Wallet saved successfully.
            </div>
          )}

          {saveState === 'error' && saveError && (
            <div className="flex items-center justify-between bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
              {saveError}
              <button onClick={() => setSaveState('idle')} className="ml-2 text-red-400 hover:text-red-600">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <form onSubmit={handleSaveWallet} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                {hasWallet ? 'Replace wallet phrase' : 'Wallet phrase'}
                <span className="text-gray-400 font-normal ml-1">(BIP39 mnemonic or 0x… private key)</span>
              </label>
              <textarea
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors resize-none font-mono"
                value={phrase}
                onChange={e => setPhrase(e.target.value)}
                placeholder="word1 word2 word3 … word12"
                rows={3}
                required
              />
              <p className="text-xs text-gray-400 mt-1">
                AES-256-GCM encrypted at rest · never returned to client
              </p>
            </div>
            <button
              type="submit"
              disabled={saveState === 'saving'}
              className="bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
            >
              {saveState === 'saving' ? 'Saving…' : hasWallet ? 'Replace wallet' : 'Save wallet'}
            </button>
          </form>
        </div>

        {/* Logout */}
        <div className="bg-white/60 backdrop-blur-sm rounded-2xl border border-white/80 shadow-sm p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-4">Session</h2>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Sign out of your account</p>
            <button
              onClick={handleLogout}
              className="text-sm font-medium text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-4 py-2 rounded-xl transition-colors"
            >
              Log out
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
