import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const webNodeModules = fileURLToPath(new URL('./node_modules', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sparky/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@sparky/platform-contract': fileURLToPath(new URL('../../packages/platform-contract/src/index.ts', import.meta.url)),
      '@sparky/platform-web': fileURLToPath(new URL('../../packages/platform-web/src/index.ts', import.meta.url)),
      '@sparky/frontend-core': fileURLToPath(new URL('../../packages/frontend-core/src/index.tsx', import.meta.url)),
      '@testing-library/react': fileURLToPath(new URL('./node_modules/@testing-library/react/dist/index.js', import.meta.url)),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['../../packages/frontend-core/src/__tests__/**/*.test.tsx'],
    server: {
      deps: {
        inline: ['@testing-library/react'],
      },
      fs: {
        allow: ['../..', webNodeModules],
      },
    },
  },
  server: {
    fs: {
      allow: ['../..', webNodeModules],
    },
    port: 5174,
  },
})
