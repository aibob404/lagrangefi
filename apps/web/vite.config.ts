import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import { mockApiPlugin } from './mock-api'

const useMock = process.env.MOCK === 'true'
const apiHost = process.env.API_HOST ?? 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    ...(useMock ? [mockApiPlugin()] : []),
  ],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    ...(useMock ? {} : {
      proxy: {
        '/api': apiHost,
        '/auth': apiHost,
        '/me': apiHost,
      },
    }),
  },
})
