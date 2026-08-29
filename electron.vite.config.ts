import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const projectRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          about: resolve(projectRoot, 'src/preload/about.ts'),
          'plugin-manager': resolve(projectRoot, 'src/preload/plugin-manager.ts'),
          failure: resolve(projectRoot, 'src/preload/failure.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(projectRoot, 'src/renderer'),
    server: { hmr: false },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          about: resolve(projectRoot, 'src/renderer/index.html'),
          'plugin-manager': resolve(projectRoot, 'src/renderer/plugin-manager/index.html'),
          failure: resolve(projectRoot, 'src/renderer/failure/index.html'),
        },
      },
    },
  },
})
