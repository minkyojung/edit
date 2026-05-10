// Flat config — minimum surface that catches the *kind* of regression
// we shipped (broken @milkdown direct imports). Style rules are out of
// scope on purpose: introducing them now would explode the diff and
// drown the signal that matters.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'src-tauri/**',
      'sidecar/**',
      'sidecar-pkg/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // ZWS (U+200B) is a load-bearing character in this codebase —
      // it appears intentionally inside regex literals (to strip it
      // from markdown bodies) and inside comments documenting that
      // behavior. Lint should still flag it in plain strings.
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipRegExps: true, skipComments: true, skipTemplates: true },
      ],

      // Force the @milkdown/kit/* surface for everything kit re-exports.
      // The previous regression (`import { $prose } from '@milkdown/utils'`)
      // shipped silently; this rule turns the same mistake into a lint error.
      // Allowed: @milkdown/kit + subpaths, @milkdown/react (peer entry), and
      // @milkdown/plugin-collab (truly external — kit doesn't re-export it).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@milkdown/*',
                '!@milkdown/kit',
                '!@milkdown/kit/*',
                '!@milkdown/react',
                '!@milkdown/plugin-collab',
              ],
              message:
                'Use @milkdown/kit/<subpath> instead of importing the underlying package directly.',
            },
          ],
        },
      ],

      // Hand-written types/anys leak constantly in third-party glue;
      // tighten only the bits that bite us, leave the rest pragmatic.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
