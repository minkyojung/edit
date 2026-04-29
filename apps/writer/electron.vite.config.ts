import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src/renderer/src') },
      dedupe: [
        '@milkdown/kit',
        '@milkdown/plugin-collab',
        '@milkdown/core',
        '@milkdown/ctx',
        'yjs',
        'y-prosemirror',
        'y-protocols',
        'lib0',
        'prosemirror-model',
        'prosemirror-state',
        'prosemirror-view',
        'prosemirror-transform',
        'remark-frontmatter',
      ]
    }
  }
})
