import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import StrategyPage from './pages/StrategyPage'
import ProfilePage from './pages/ProfilePage'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          {/* Protected */}
          <Route path="/strategies" element={
            <ProtectedRoute><Layout><StrategyPage /></Layout></ProtectedRoute>
          } />
          <Route path="/profile" element={
            <ProtectedRoute><Layout><ProfilePage /></Layout></ProtectedRoute>
          } />

          {/* Redirects */}
          <Route path="/dashboard" element={<Navigate to="/strategies" replace />} />
          <Route path="/wallet"    element={<Navigate to="/profile"    replace />} />
          <Route path="/"          element={<Navigate to="/strategies" replace />} />
          <Route path="*"          element={<Navigate to="/strategies" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
