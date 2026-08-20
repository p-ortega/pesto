import { defineConfig } from 'vite'

export default defineConfig({
  // root is left as the default (process.cwd()) -- npm scripts already
  // run with cwd set to this frontend/ directory, and an explicit
  // "frontend" root here would double up to frontend/frontend.
  build: {
    outDir: '../src/pesto/static',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
