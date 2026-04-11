import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  esbuild: {
    // Strip console.* and debugger statements from production builds.
    drop: command === 'build' ? ['console', 'debugger'] : [],
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
      }
    }
  },
}))
