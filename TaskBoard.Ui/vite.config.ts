import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '^/(tickets|runs|eligible|pick-next|validate|events|healthz|deps)': {
        target: 'http://localhost:5005',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
})
