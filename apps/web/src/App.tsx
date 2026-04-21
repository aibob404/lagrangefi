import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import StrategyPage from './pages/StrategyPage'
import ProfilePage from './pages/ProfilePage'
import TraderPage from './pages/TraderPage'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          {/* Protected */}
          <Route path="/dashboard" element={
            <ProtectedRoute><Layout><StrategyPage view="dashboard" /></Layout></ProtectedRoute>
          } />
          <Route path="/closed" element={
            <ProtectedRoute><Layout><StrategyPage view="closed" /></Layout></ProtectedRoute>
          } />
          <Route path="/profile" element={
            <ProtectedRoute><Layout><ProfilePage /></Layout></ProtectedRoute>
          } />
          <Route path="/trader" element={
            <ProtectedRoute><Layout><TraderPage /></Layout></ProtectedRoute>
          } />

          {/* Redirects */}
          <Route path="/strategies" element={<Navigate to="/dashboard" replace />} />
          <Route path="/wallet"     element={<Navigate to="/profile"   replace />} />
          <Route path="/"           element={<Navigate to="/dashboard" replace />} />
          <Route path="*"           element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
