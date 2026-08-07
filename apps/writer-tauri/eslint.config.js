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

// Local rule: `writeVaultFile` is the raw disk escape hatch, and a doc's
// durable body has exactly ONE writer — the docFileSync flush, fed by
// updateDocBody. Writing a scanned `.md` directly is invisible to both the
// open editor and the dirty tracker, so it either destroys the user's unsaved
// keystrokes (the rename-wikilinks bug) or is silently overwritten by the next
// flush (the skill-accept bug). Both shipped.
//
// The selector is on the IMPORT rather than the call: there is exactly one
// `writeVaultFile` in the codebase, so the name is unambiguous, and banning
// the import also covers aliased and indirect call forms.
//
// What this does NOT buy: the allowlist below is path-based, so a file on it
// can still add a bad write and lint will say nothing. It buys "a new module
// cannot reach disk without justifying itself in this file" — which is the
// step both shipped bugs skipped.
const vaultWriteOwnerRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Route document-body writes through updateDocBody(); the docFileSync flush is the only sanctioned disk writer.',
    },
    messages: {
      useDocBody:
        'writeVaultFile writes disk behind the open editor. A doc body goes through ' +
        'updateDocBody() (state/docsStore/docBody.ts), which reads the LIVE editor, ' +
        'serializes per slug, and marks the slug dirty so the docFileSync flush persists it. ' +
        'If this module legitimately owns a file the funnel does not cover, add it to the ' +
        'allowlist block in eslint.config.js with a one-line reason.',
    },
    schema: [],
  },
  create(context) {
    return {
      "ImportSpecifier[imported.name='writeVaultFile']"(node) {
        context.report({ node, messageId: 'useDocBody' })
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
          'vault-write-owner': vaultWriteOwnerRule,
        },
      },
    },
    rules: {
      'writer/transact-origin': 'error',
      'writer/vault-write-owner': 'error',
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

      // A doc's body mirror (`handle.bodyMarkdown`) may ONLY be written through
      // the owner module state/docsStore/docBody.ts (updateDocBody /
      // setBodyMirror), which makes the read-modify-write atomic. A raw
      // assignment anywhere else is the scattered-writer pattern that caused
      // silent save-loss. TypeScript already blocks it (the field is readonly);
      // this is the backstop that also catches `as`-cast bypasses and .tsx.
      // Disabled in docBody.ts (the owner) and test files (mock setup) below.
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.property.name='bodyMarkdown']",
          message:
            'Never assign handle.bodyMarkdown directly — route through updateDocBody()/setBodyMirror() in state/docsStore/docBody.ts.',
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
  {
    // The body-write owner and test mock-setup legitimately assign
    // bodyMarkdown; exempt them from the no-direct-assignment rule.
    files: ['src/state/docsStore/docBody.ts', 'src/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Modules that own a file the doc-body funnel does not cover. Each line
    // says why; adding one without a reason is the thing this rule exists to
    // make somebody stop and do.
    files: [
      'src/lib/vault.ts', // defines it
      'src/lib/docFileSync.ts', // THE doc writer — the flush the rule points at
      // Both of these write a doc's markdown, but only on the branch where the
      // doc has NO live handle (no mirror, no editor — disk is the note).
      // Routing those through the funnel would build a handle per note, which
      // marks the slug dirty and never frees it.
      'src/lib/renameWikilinks.ts',
      'src/state/skillProposalStore.ts',
      'src/state/wikiIndex.ts', // generated _system/index.md, documented overwrite contract
      'src/state/vaultTimeline.ts', // generated timeline page, same contract
      'src/lib/threadFiles.ts', // .octave/threads — dot-dir, never scanned as docs
      'src/lib/assetTombstone.ts', // .json bookkeeping, not a doc
      'src/lib/claudeImport.ts', // one-shot import, runs before the first scan
      'src/lib/commandsLib.ts', // create-if-absent seed (vaultFileExists-guarded)
      'src/lib/agentsLib.ts', // create-if-absent seed
      'src/lib/skillsLib.ts', // create-if-absent seed
      'src/lib/templates.ts', // create-if-absent seed
      'src/lib/seedClaudeMd.ts', // one-shot migration, guarded on both sides
      'src/**/*.test.{ts,tsx}', // mocks + vault's own unit tests
    ],
    rules: { 'writer/vault-write-owner': 'off' },
  },
  {
    // Build/CI helper scripts run under Node, not the browser — declare its
    // globals so `no-undef` (from js.recommended) doesn't flag console /
    // process / URL etc. Flat config ignores `/* eslint-env node */`, so the
    // environment has to be set here.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'writable',
      },
    },
  },
)
