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
        <h1 className="text-2xl font-bold text-gray-900">Wallet</h1>
        <p className="text-sm text-gray-500 mt-1">
          All Your Wallet And Security Settings
        </p>
      </div>

      <div className="max-w-lg">
        {hasWallet && !success && (
          <div className="mb-4 flex items-center gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Wallet configured. You can replace it below.
          </div>
        )}

        {success && (
          <div className="mb-4 flex items-center gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Wallet saved.{' '}
            <button className="underline font-medium" onClick={() => navigate('/strategies')}>
              Create a strategy →
            </button>
          </div>
        )}

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        <div className="bg-white/60 backdrop-blur-sm rounded-2xl shadow-sm border border-white/80 p-6">
          <div className="flex items-start gap-3 mb-5 pb-5 border-b border-gray-100">
            <div className="w-9 h-9 bg-gray-100 rounded-xl flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                <line x1="1" y1="10" x2="23" y2="10" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Hot wallet</p>
              <p className="text-xs text-gray-500 mt-0.5">
                Encrypted with AES-256-GCM before storage. Never returned to client.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                Wallet phrase <span className="text-gray-400 font-normal">(BIP39 mnemonic or 0x… private key)</span>
              </label>
              <textarea
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-colors resize-none font-mono"
                value={phrase}
                onChange={e => setPhrase(e.target.value)}
                placeholder="word1 word2 word3 … word12"
                rows={3}
                required
              />
              <p className="text-xs text-gray-400 mt-1.5">
                12 or 24-word mnemonic (m/44'/60'/0'/0/0) or hex private key.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
            >
              {loading ? 'Saving…' : hasWallet ? 'Replace wallet' : 'Save wallet'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
