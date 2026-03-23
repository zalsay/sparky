import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sparky/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@sparky/platform-contract': fileURLToPath(new URL('../../packages/platform-contract/src/index.ts', import.meta.url)),
      '@sparky/platform-web': fileURLToPath(new URL('../../packages/platform-web/src/index.ts', import.meta.url)),
      '@sparky/frontend-core': fileURLToPath(new URL('../../packages/frontend-core/src/index.tsx', import.meta.url)),
    },
  },
  server: {
    port: 5174,
  },
})
