import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('pdfjs-dist')) return 'pdfjs'
          if (
            id.includes('react-markdown') ||
            id.includes('remark-gfm') ||
            id.includes('micromark') ||
            id.includes('mdast-util') ||
            id.includes('hast-util') ||
            id.includes('unified')
          ) return 'markdown'
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react'
          return undefined
        },
      },
    },
  },
})
