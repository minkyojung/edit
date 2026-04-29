import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)

// proof-sdk lives at ../proof-sdk (sibling of managua), so Node's directory
// walk-up from proof-sdk's source files never reaches managua/node_modules.
// This plugin intercepts every bare import that originates from proof-sdk
// source and resolves it against managua's node_modules instead.
function proofSdkDepsPlugin(): Plugin {
  const managuaRoot = path.resolve(__dirname, '../..')
  // pnpm deduplicates shared transitive deps here (e.g. @milkdown/prose)
  const pnpmShared = path.resolve(managuaRoot, 'node_modules/.pnpm/node_modules')
  const resolvePaths = [managuaRoot, pnpmShared]

  return {
    name: 'resolve-proof-sdk-deps',
    resolveId(id, importer) {
      if (!importer?.includes('/proof-sdk/src/')) return null
      // Skip relative / absolute imports — those resolve fine on their own
      if (id.startsWith('.') || id.startsWith('/')) return null
      try {
        return require.resolve(id, { paths: resolvePaths })
      } catch {
        return null
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss(), proofSdkDepsPlugin()],
    resolve: {
      alias: (() => {
        const stubs = path.resolve(__dirname, 'src/renderer/stubs')
        const shared = path.resolve(__dirname, '../../node_modules/.pnpm/node_modules')
        const mk = (pkg: string) => `${shared}/@milkdown/${pkg}`
        const kitLib = `${shared}/@milkdown/kit/lib`
        return {
          '@': path.resolve(__dirname, 'src/renderer/src'),
          // Stubbed: not installed or not meaningful in Electron
          '@milkdown/theme-nord': `${stubs}/milkdown-theme-nord.ts`,
          'web-haptics': `${stubs}/web-haptics.ts`,
          'beautiful-mermaid': `${stubs}/beautiful-mermaid.ts`,
          // @milkdown/kit subpaths — exact aliases prevent subpath-mangling
          '@milkdown/kit/core': `${kitLib}/core.js`,
          '@milkdown/kit/ctx': `${kitLib}/ctx.js`,
          '@milkdown/kit/utils': `${kitLib}/utils.js`,
          '@milkdown/kit/prose/keymap': `${kitLib}/prose/keymap.js`,
          '@milkdown/kit/prose/model': `${kitLib}/prose/model.js`,
          '@milkdown/kit/prose/state': `${kitLib}/prose/state.js`,
          '@milkdown/kit/prose/transform': `${kitLib}/prose/transform.js`,
          '@milkdown/kit/prose/view': `${kitLib}/prose/view.js`,
          '@milkdown/kit/preset/commonmark': `${kitLib}/preset/commonmark.js`,
          '@milkdown/kit/plugin/listener': `${kitLib}/plugin/listener.js`,
          // @milkdown/prose subpath exports — require.resolve can't handle ESM
          // subpaths, so we map directly to the file. Only add subpaths that
          // proof-sdk source files import directly.
          '@milkdown/prose/tables': path.resolve(__dirname, '../../node_modules/@milkdown/prose/lib/tables.js'),
          // Individual milkdown packages
          '@milkdown/core': mk('core'),
          '@milkdown/preset-commonmark': mk('preset-commonmark'),
          '@milkdown/preset-gfm': mk('preset-gfm'),
          '@milkdown/plugin-history': mk('plugin-history'),
          '@milkdown/plugin-listener': mk('plugin-listener'),
          '@milkdown/plugin-cursor': mk('plugin-cursor'),
          '@milkdown/plugin-clipboard': mk('plugin-clipboard'),
          '@milkdown/plugin-collab': mk('plugin-collab'),
          // yjs packages
          'y-prosemirror': `${shared}/y-prosemirror`,
          'y-protocols': `${shared}/y-protocols`,
          'lib0': `${shared}/lib0`,
        }
      })(),
    },
    build: {
      rollupOptions: {
        // prismjs is a dynamic import inside try-catch in proof-sdk's loadPrismPlugin().
        // Marking it external lets the build pass; at runtime in Electron the import()
        // will fail, the catch returns null, and the editor works without syntax highlighting.
        external: (id: string) =>
          id === 'prismjs' ||
          id.startsWith('prismjs/') ||
          id === '@milkdown/plugin-prism',
      },
    },
  }
})
