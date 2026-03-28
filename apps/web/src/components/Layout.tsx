import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

function ActivityIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function LogOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  )
}


export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [mobileOpen, setMobileOpen] = useState(false)

  const isActive = (path: string) => location.pathname.startsWith(path)

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <div className="flex flex-col min-h-screen relative">

      {/* Ambient background blobs */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-32 -right-32 w-[500px] h-[500px] bg-emerald-400/25 rounded-full blur-[100px]" />
        <div className="absolute -bottom-32 -left-32 w-[500px] h-[500px] bg-blue-500/20 rounded-full blur-[100px]" />
        <div className="absolute top-1/2 left-1/3 -translate-y-1/2 w-[600px] h-[400px] bg-violet-400/15 rounded-full blur-[120px]" />
      </div>

      {/* ── Top navbar ───────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 backdrop-blur-2xl bg-white/50 border-b border-white/60 shadow-sm shadow-black/5">
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center">

          {/* Left — logo */}
          <Link to="/dashboard" className="flex items-center gap-2 group shrink-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-gradient-to-br from-gray-800 to-gray-950 shadow-md group-hover:shadow-lg transition-shadow">
              <span className="text-white font-bold text-sm leading-none">Δ</span>
            </div>
            <span className="hidden sm:block text-gray-900 font-bold text-sm tracking-tight">lagrangefi</span>
          </Link>

          {/* Center — glass switcher (absolutely centered) */}
          {user && (
            <nav className="absolute left-1/2 -translate-x-1/2 flex items-center bg-white/25 backdrop-blur-md border border-white/50 rounded-full p-1 gap-0.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.6),0_1px_3px_rgba(0,0,0,0.08)]">
              <Link
                to="/dashboard"
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  isActive('/dashboard')
                    ? 'bg-white/85 text-gray-900 shadow-[0_1px_3px_rgba(0,0,0,0.12)] backdrop-blur-sm'
                    : 'text-gray-500 hover:text-gray-800 hover:bg-white/35'
                }`}
              >
                <ActivityIcon />
                Dashboard
              </Link>
              <Link
                to="/closed"
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  isActive('/closed')
                    ? 'bg-white/85 text-gray-900 shadow-[0_1px_3px_rgba(0,0,0,0.12)] backdrop-blur-sm'
                    : 'text-gray-500 hover:text-gray-800 hover:bg-white/35'
                }`}
              >
                <ArchiveIcon />
                Closed Strategies
              </Link>
            </nav>
          )}

          {/* Right — user + logout */}
          <div className="ml-auto flex items-center gap-2">
            {user && (
              <>
                {/* Username + wallet pill — desktop */}
                <Link
                  to="/profile"
                  className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-white/50 border border-white/70 hover:bg-white/80 hover:border-white/90 transition-all shadow-sm text-sm"
                >
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br from-gray-700 to-gray-950 shadow-sm">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="4"/>
                      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                    </svg>
                  </div>
                  <span className="font-semibold text-gray-900 leading-none">{user.username}</span>
                  <div className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${user.hasWallet ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="text-xs text-gray-400">{user.hasWallet ? 'Wallet' : 'No wallet'}</span>
                  </div>
                </Link>

                {/* Log out — desktop */}
                <button
                  onClick={handleLogout}
                  title="Log out"
                  className="hidden sm:flex p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50/60 transition-colors"
                >
                  <LogOutIcon />
                </button>

                {/* Hamburger — mobile */}
                <button
                  onClick={() => setMobileOpen(v => !v)}
                  className="sm:hidden p-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-white/60 transition-colors"
                  aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
                >
                  {mobileOpen ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Mobile dropdown — user actions only (nav is always visible in bar) */}
        {mobileOpen && user && (
          <div className="sm:hidden border-t border-white/50 bg-white/60 backdrop-blur-xl px-4 py-3 space-y-1">
            <Link
              to="/profile"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-gray-600 hover:text-gray-900 hover:bg-white/60 transition-colors"
            >
              <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br from-gray-700 to-gray-950 shadow-sm">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
              <span className="font-medium">{user.username}</span>
              <div className="flex items-center gap-1 ml-1">
                <span className={`w-1.5 h-1.5 rounded-full ${user.hasWallet ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                <span className="text-xs text-gray-400">{user.hasWallet ? 'Wallet connected' : 'No wallet'}</span>
              </div>
            </Link>
            <button
              onClick={() => { handleLogout(); setMobileOpen(false) }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-red-500 hover:bg-red-50/60 transition-colors"
            >
              <LogOutIcon />
              Log out
            </button>
          </div>
        )}
      </header>

      {/* Main content — now full-width */}
      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
