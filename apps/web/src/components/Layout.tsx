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
    <div className="flex flex-col min-h-screen relative text-slate-200">

      {/* ── Top navbar ───────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-slate-900/70 border-b border-slate-700/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">

          {/* Left — logo */}
          <Link to="/dashboard" className="flex items-center gap-2 group shrink-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_12px_rgba(16,185,129,0.35)] group-hover:shadow-[0_0_16px_rgba(16,185,129,0.5)] transition-shadow">
              <span className="text-slate-950 font-bold text-sm leading-none">Δ</span>
            </div>
            <span className="hidden sm:block text-slate-100 font-bold text-sm tracking-tight">lagrangefi</span>
          </Link>

          {/* Center — nav switcher */}
          {user && (
            <nav className="flex items-center bg-slate-800/60 backdrop-blur-md border border-slate-700 rounded-full p-1 gap-0.5 shrink-0">
              <Link
                to="/dashboard"
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  isActive('/dashboard')
                    ? 'bg-slate-700 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-700/60'
                }`}
              >
                <ActivityIcon />
                Dashboard
              </Link>
              <Link
                to="/closed"
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${
                  isActive('/closed')
                    ? 'bg-slate-700 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-700/60'
                }`}
              >
                <ArchiveIcon />
                <span className="hidden md:inline">Closed Strategies</span>
                <span className="md:hidden">Closed</span>
              </Link>
            </nav>
          )}

          {/* Right — user + logout */}
          <div className="flex items-center gap-2 shrink-0">
            {user && (
              <>
                {/* Username pill — desktop */}
                <Link
                  to="/profile"
                  className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700 hover:bg-slate-700/80 hover:border-slate-600 transition-all text-sm"
                >
                  <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-slate-700 border border-slate-600">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="4"/>
                      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                    </svg>
                  </div>
                  <span className="font-semibold text-slate-100 leading-none">{user.username}</span>
                  {!user.hasWallet && (
                    <div className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                      <span className="text-xs text-amber-400">No wallet</span>
                    </div>
                  )}
                </Link>

                {/* Log out — desktop */}
                <button
                  onClick={handleLogout}
                  title="Log out"
                  className="hidden sm:flex p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                >
                  <LogOutIcon />
                </button>

                {/* Hamburger — mobile */}
                <button
                  onClick={() => setMobileOpen(v => !v)}
                  className="sm:hidden p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
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

        {/* Mobile dropdown */}
        {mobileOpen && user && (
          <div className="sm:hidden border-t border-slate-700/80 bg-slate-900/90 backdrop-blur-xl px-4 py-3 space-y-1">
            <Link
              to="/profile"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700/60 transition-colors"
            >
              <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-slate-700 border border-slate-600">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
              <span className="font-medium">{user.username}</span>
              {!user.hasWallet && (
                <div className="flex items-center gap-1 ml-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  <span className="text-xs text-amber-400">No wallet</span>
                </div>
              )}
            </Link>
            <button
              onClick={() => { handleLogout(); setMobileOpen(false) }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <LogOutIcon />
              Log out
            </button>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
