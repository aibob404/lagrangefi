import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

// ── Icons ────────────────────────────────────────────────────────────────────
type IconProps = React.SVGProps<SVGSVGElement>
const icon = (path: React.ReactNode) => ({ width = 18, height = 18, ...rest }: IconProps) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {path}
  </svg>
)

const IconShuffle  = icon(<><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></>)
const IconBell     = icon(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></>)
const IconChart    = icon(<><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-6"/></>)
const IconSettings = icon(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>)
const IconLogout   = icon(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>)
const IconChevrons = icon(<><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></>)

// ── Nav config ───────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: 'uniswap', label: 'Uniswap auto-rebalance', icon: IconShuffle, href: '/dashboard', status: 'live' as const },
  { id: 'alerts',    label: 'Alerts',    icon: IconBell,   href: '#',        status: 'planned' as const },
  { id: 'analytics', label: 'Analytics', icon: IconChart,  href: '#',        status: 'planned' as const },
]

const SYSTEM_ITEMS = [
  { id: 'settings', label: 'Settings', icon: IconSettings, href: '#' },
]

// ── Component ────────────────────────────────────────────────────────────────
export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const activeId = (() => {
    if (location.pathname.startsWith('/closed'))  return 'closed'
    if (location.pathname.startsWith('/profile')) return 'wallet'
    return 'uniswap'
  })()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const userInitial = user?.username?.[0]?.toUpperCase() ?? '?'

  return (
    <div className="flex h-screen overflow-hidden bg-[#f3f4f6]">

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className={`${collapsed ? 'w-[68px]' : 'w-[248px]'} shrink-0 transition-[width] duration-300 ease-out relative z-10`}>
        <div className="h-full flex flex-col bg-white/55 backdrop-blur-2xl border-r border-white/70 shadow-[0_0_0_1px_rgba(255,255,255,0.4)_inset]">

          {/* Brand */}
          <div className={`h-14 flex items-center ${collapsed ? 'justify-center' : 'px-4'} border-b border-black/5`}>
            <Link to="/dashboard" className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-[10px] flex items-center justify-center bg-gradient-to-br from-gray-800 to-black shadow-md shrink-0">
                <span className="text-white font-bold text-[15px] leading-none">Δ</span>
              </div>
              {!collapsed && (
                <div className="min-w-0">
                  <div className="text-[14px] font-bold tracking-tight leading-none text-gray-900">lagrangefi</div>
                  <div className="text-[10px] mt-1 leading-none uppercase tracking-[0.08em] text-gray-400">Arbitrum · v2</div>
                </div>
              )}
            </Link>
          </div>

          {/* Primary nav */}
          <nav className="flex-1 overflow-y-auto nice-scroll px-2 pt-3 pb-2 flex flex-col gap-1">
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-400">
                Strategies
              </div>
            )}

            {NAV_ITEMS.map(item => {
              const Icon = item.icon
              const isPlanned = item.status === 'planned'
              const isActive = activeId === item.id

              return (
                <div
                  key={item.id}
                  onClick={() => { if (!isPlanned) navigate(item.href) }}
                  className={[
                    'has-tip relative cursor-pointer rounded-xl py-2 flex items-center gap-2.5 transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-2.5',
                    isPlanned ? 'opacity-70 cursor-not-allowed' : '',
                    isActive ? 'bg-white/90 shadow-[0_1px_2px_rgba(0,0,0,0.06)] text-gray-900' : 'hover:bg-white/60 text-gray-500',
                  ].join(' ')}
                >
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full accent-dot" />
                  )}
                  <div className={`shrink-0 ${isActive ? 'accent-text' : ''}`}>
                    <Icon />
                  </div>
                  {!collapsed && (
                    <>
                      <span className={`flex-1 text-[13.5px] font-medium tracking-tight truncate ${isActive ? 'text-gray-900' : ''}`}>
                        {item.label}
                      </span>
                      {isPlanned && (
                        <span className="mono text-[10px] rounded-md px-1.5 py-0.5 font-semibold bg-black/5 text-gray-500">
                          soon
                        </span>
                      )}
                    </>
                  )}
                  {collapsed && <span className="tip">{item.label}</span>}
                </div>
              )
            })}

            {/* System group */}
            <div className="mt-auto pt-3 border-t border-black/5 flex flex-col gap-1">
              {!collapsed && (
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-400">
                  System
                </div>
              )}
              {SYSTEM_ITEMS.map(item => {
                const Icon = item.icon
                const isActive = activeId === item.id
                return (
                  <div
                    key={item.id}
                    className={[
                      'has-tip relative cursor-pointer rounded-xl py-2 flex items-center gap-2.5 transition-colors',
                      collapsed ? 'justify-center px-0' : 'px-2.5',
                      isActive ? 'bg-white/90 text-gray-900' : 'hover:bg-white/60 text-gray-500',
                    ].join(' ')}
                  >
                    <Icon />
                    {!collapsed && <span className="flex-1 text-[13.5px] font-medium tracking-tight truncate">{item.label}</span>}
                    {collapsed && <span className="tip">{item.label}</span>}
                  </div>
                )
              })}
            </div>
          </nav>

          {/* User section */}
          {user && (
            <div className={`border-t border-black/5 ${collapsed ? 'p-2' : 'p-2.5'}`}>
              <div className={[
                'has-tip relative flex items-center gap-2.5 rounded-xl hover:bg-white/60 cursor-pointer transition-colors',
                collapsed ? 'justify-center p-1.5' : 'p-2',
              ].join(' ')}>
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-gray-700 to-gray-950 flex items-center justify-center shrink-0 shadow-sm">
                  <span className="text-white font-semibold text-[13px]">{userInitial}</span>
                </div>
                {!collapsed && (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold leading-none truncate text-gray-900">{user.username}</div>
                      <div className="flex items-center gap-1 mt-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${user.hasWallet ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                        <span className="mono text-[10.5px] text-gray-400">{user.hasWallet ? 'Wallet' : 'No wallet'}</span>
                      </div>
                    </div>
                    <button title="Log out" onClick={handleLogout} className="p-1.5 rounded-md text-gray-500 hover:text-red-500 transition-colors">
                      <IconLogout />
                    </button>
                  </>
                )}
                {collapsed && <span className="tip">{user.username}</span>}
              </div>
            </div>
          )}

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(v => !v)}
            className="absolute top-[52px] -right-3 w-6 h-6 rounded-full border bg-white border-black/10 text-gray-500 shadow-md flex items-center justify-center hover:scale-105 transition-transform z-20"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <span style={{ transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
              <IconChevrons />
            </span>
          </button>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 relative overflow-hidden">
        {/* Ambient blobs */}
        <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute -top-32 -right-32 w-[500px] h-[500px] rounded-full blur-[100px]"
               style={{ background: 'oklch(75% 0.12 160 / 0.22)' }} />
          <div className="absolute -bottom-40 -left-40 w-[500px] h-[500px] rounded-full blur-[100px]"
               style={{ background: 'oklch(70% 0.11 220 / 0.18)' }} />
        </div>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
