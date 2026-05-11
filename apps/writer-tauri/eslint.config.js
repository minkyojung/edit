// Flat config — minimum surface that catches the *kind* of regression
// we shipped (broken @milkdown direct imports). Style rules are out of
// scope on purpose: introducing them now would explode the diff and
// drown the signal that matters.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Local rule: every `ydoc.transact(fn)` call must pass an origin
// string as the second argument. The origin determines which
// UndoManager trackedOrigins bucket the change lands in (see
// editor/MilkdownEditor.tsx). A missing origin is recorded as
// null, which usually means "not undo-tracked" — sometimes the
// right answer, sometimes a silent bug. The rule forces every
// site to make the call explicit at code-author time.
//
// Selector matches *.transact() with the callee being a member
// expression — covers `ydoc.transact(...)`, `handle.ydoc.transact(...)`,
// `this.ydoc.transact(...)`, etc. `transact` is unique to Y.Doc in our
// codebase, so the selector is precise enough without type info.
const transactOriginRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an explicit origin (string) as the second argument to ydoc.transact() calls.',
    },
    messages: {
      missingOrigin:
        "ydoc.transact() requires an origin as its second argument. " +
        "Use one of the labels the UndoManager knows about " +
        "(see editor/MilkdownEditor.tsx trackedOrigins): " +
        "'mark-action' / 'mark-cleanup' for user-undoable mark edits, " +
        "'doc-init' for system bootstrap/migration writes, " +
        "'chat-meta' for thread/turn metadata that should stay out of the doc undo stack.",
    },
    schema: [],
  },
  create(context) {
    return {
      'CallExpression[callee.type="MemberExpression"][callee.property.name="transact"]'(node) {
        if (node.arguments.length < 2) {
          context.report({ node, messageId: 'missingOrigin' })
        }
      },
    }
  },
}

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
    plugins: {
      writer: {
        rules: {
          'transact-origin': transactOriginRule,
        },
      },
    },
    rules: {
      'writer/transact-origin': 'error',
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
