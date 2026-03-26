import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

function HomeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function ActivityIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()

  const isActive = (path: string) => location.pathname.startsWith(path)

  const navItem = (to: string, icon: React.ReactNode, label: string) => (
    <Link
      to={to}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
        isActive(to)
          ? 'bg-white/15 text-white'
          : 'text-gray-400 hover:bg-white/8 hover:text-gray-200'
      }`}
    >
      {icon}
      {label}
    </Link>
  )

  return (
    <div className="flex min-h-screen">
      {/* Single dark sidebar */}
      <aside className="w-52 bg-gray-900/92 backdrop-blur-sm flex flex-col shrink-0 border-r border-white/5">
        {/* Logo */}
        <Link to="/strategies" className="flex items-center gap-2.5 px-4 py-5 border-b border-white/8">
          <div className="w-7 h-7 bg-white/10 rounded-lg flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm leading-none">Δ</span>
          </div>
          <span className="text-white font-semibold text-sm tracking-tight">lagrangefi</span>
        </Link>

        {/* Nav items */}
        {user && (
          <nav className="flex-1 px-2 py-4 space-y-0.5">
            {navItem('/strategies', <ActivityIcon />, 'Strategies')}
          </nav>
        )}

        {/* User avatar → profile */}
        {user && (
          <Link
            to="/profile"
            className={`flex items-center gap-3 mx-2 mb-3 px-3 py-2.5 rounded-xl transition-all ${
              isActive('/profile')
                ? 'bg-white/15 text-white'
                : 'text-gray-400 hover:bg-white/8 hover:text-gray-200'
            }`}
          >
            <div className="w-7 h-7 rounded-full bg-white/15 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {user.username[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-200 truncate leading-tight">{user.username}</p>
              <p className="text-xs text-gray-500 leading-tight">Profile</p>
            </div>
          </Link>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
