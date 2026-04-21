import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchWalletStatus, saveWallet } from '../api'
import { useAuth } from '../context/AuthContext'

export default function WalletPage() {
  const { user, setUser } = useAuth()
  const navigate = useNavigate()
  const [phrase, setPhrase] = useState('')
  const [hasWallet, setHasWallet] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchWalletStatus().then(r => setHasWallet(r.hasWallet))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setLoading(true)
    try {
      await saveWallet(phrase)
      setHasWallet(true)
      setSuccess(true)
      setPhrase('')
      if (user) setUser({ ...user, hasWallet: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save wallet')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Wallet</h1>
        <p className="text-sm text-slate-400 mt-1">
          All Your Wallet And Security Settings
        </p>
      </div>

      <div className="max-w-lg">
        {hasWallet && !success && (
          <div className="mb-4 flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm rounded-lg px-4 py-3">
            <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Wallet configured. You can replace it below.
          </div>
        )}

        {success && (
          <div className="mb-4 flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm rounded-lg px-4 py-3">
            <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Wallet saved.{' '}
            <button className="underline font-medium text-emerald-200 hover:text-emerald-100" onClick={() => navigate('/strategies')}>
              Create a strategy →
            </button>
          </div>
        )}

        {error && (
          <div className="mb-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        <div className="bg-slate-800/70 backdrop-blur-md rounded-xl shadow-lg shadow-black/20 border border-slate-700 p-6">
          <div className="flex items-start gap-3 mb-5 pb-5 border-b border-slate-700">
            <div className="w-9 h-9 bg-slate-700 border border-slate-600 rounded-lg flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                <line x1="1" y1="10" x2="23" y2="10" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-100">Hot wallet</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Encrypted with AES-256-GCM before storage. Never returned to client.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Wallet phrase <span className="text-slate-500 font-normal">(BIP39 mnemonic or 0x… private key)</span>
              </label>
              <textarea
                className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:bg-slate-700 transition-colors resize-none font-mono"
                value={phrase}
                onChange={e => setPhrase(e.target.value)}
                placeholder="word1 word2 word3 … word12"
                rows={3}
                required
              />
              <p className="text-xs text-slate-500 mt-1.5">
                12 or 24-word mnemonic (m/44'/60'/0'/0/0) or hex private key.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 disabled:hover:bg-emerald-400 text-slate-950 text-sm font-semibold py-2.5 rounded-lg transition-colors"
            >
              {loading ? 'Saving…' : hasWallet ? 'Replace wallet' : 'Save wallet'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
