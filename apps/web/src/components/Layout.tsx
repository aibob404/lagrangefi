import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()

  const isActive = (path: string) => location.pathname.startsWith(path)

  const navItem = (to: string, icon: React.ReactNode, label: string) => {
    const active = isActive(to)
    return (
      <Link
        to={to}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 ${
          active
            ? 'bg-gray-900 text-white shadow-sm'
            : 'text-gray-600 hover:text-gray-900 hover:bg-black/6'
        }`}
      >
        {icon}
        {label}
      </Link>
    )
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-52 bg-white/55 backdrop-blur-xl flex flex-col shrink-0 border-r border-white/70">
        {/* Logo */}
        <Link to="/strategies" className="flex items-center gap-2.5 px-4 py-5 border-b border-black/6">
          <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm leading-none">Δ</span>
          </div>
          <span className="text-gray-900 font-bold text-sm tracking-tight">lagrangefi</span>
        </Link>

        {/* Nav */}
        {user && (
          <nav className="flex-1 px-2 py-4 space-y-0.5">
            {navItem('/strategies', <ActivityIcon />, 'Strategies')}
          </nav>
        )}

        {/* Profile */}
        {user && (
          <Link
            to="/profile"
            className={`flex items-center gap-3 mx-2 mb-3 px-3 py-2.5 rounded-xl transition-all duration-150 ${
              isActive('/profile')
                ? 'bg-gray-900 text-white'
                : 'hover:bg-black/6'
            }`}
          >
            <div className="w-7 h-7 rounded-full bg-gray-900 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {user.username[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-semibold truncate leading-tight ${isActive('/profile') ? 'text-white' : 'text-gray-800'}`}>
                {user.username}
              </p>
              <p className={`text-xs leading-tight ${isActive('/profile') ? 'text-white/60' : 'text-gray-500'}`}>Profile</p>
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
