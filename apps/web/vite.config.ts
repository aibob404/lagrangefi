import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import { mockApiPlugin } from './mock-api'

const useMock = process.env.MOCK === 'true'

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
        '/api': 'http://187.124.224.48',
        '/auth': 'http://187.124.224.48',
        '/me': 'http://187.124.224.48',
      },
    }),
  },
})
