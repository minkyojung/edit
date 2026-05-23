---
source: https://milkdown.dev/docs/api/crepe
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/crepe"
---

# @milkdown/crepe

The crepe editor, built on top of milkdown.

## Features

Crepe provides a rich set of features that can be enabled or disabled through configuration. By default, most features are enabled except for `TopBar` and `AI`:

```typescript
const defaultFeatures: Record<CrepeFeature, boolean> = {
  [Crepe.Feature.Cursor]: true,
  [Crepe.Feature.ListItem]: true,
  [Crepe.Feature.LinkTooltip]: true,
  [Crepe.Feature.ImageBlock]: true,
  [Crepe.Feature.BlockEdit]: true,
  [Crepe.Feature.Placeholder]: true,
  [Crepe.Feature.Toolbar]: true,
  [Crepe.Feature.CodeMirror]: true,
  [Crepe.Feature.Table]: true,
  [Crepe.Feature.Latex]: true,
  [Crepe.Feature.TopBar]: false,
  [Crepe.Feature.AI]: false,
}
```

You can disable specific features by setting them to `false` in the `features` configuration.

## Icon Configuration

Many features allow customizing their icons. You can provide icons as strings:

```typescript
const config: CrepeConfig = {
  featureConfigs: {
    [Crepe.Feature.Toolbar]: {
      boldIcon: '<svg>...</svg>',
      italicIcon: '<svg>...</svg>',
    },
  },
}
```

## Configuration

The Crepe editor can be configured through the `CrepeConfig` interface:

```typescript
interface CrepeConfig {
  features?: Partial<Record<CrepeFeature, boolean>> // Enable/disable specific features
  featureConfigs?: CrepeFeatureConfig // Configure individual features
  root?: Node | string | null // Root element for the editor
  defaultValue?: DefaultValue // Initial content
}
```

### Builder Configuration

The `CrepeBuilder` can be configured through the `CrepeBuilderConfig` interface:

```typescript
interface CrepeBuilderConfig {
  /// The root element for the editor.
  /// Supports both DOM nodes and CSS selectors,
  /// If not provided, the editor will be appended to the body.
  root?: Node | string | null

  /// The default value for the editor.
  defaultValue?: DefaultValue
}
```

### Feature Configurations

Each feature can be configured individually. Here are the available configurations for each feature:

#### Cursor Feature

```typescript
interface CursorFeatureConfig {
  color?: string | false // Custom cursor color
  width?: number // Cursor width in pixels
  virtual?: boolean // Enable/disable virtual cursor
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.Cursor]: true,
  },
  featureConfigs: {
    [Crepe.Feature.Cursor]: {
      color: '#ff0000',
      width: 2,
      virtual: true,
    },
  },
}
```

#### ListItem Feature

```typescript
interface ListItemFeatureConfig {
  bulletIcon?: string // Custom bullet list icon
  checkBoxCheckedIcon?: string // Custom checked checkbox icon
  checkBoxUncheckedIcon?: string // Custom unchecked checkbox icon
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.ListItem]: true,
  },
  featureConfigs: {
    [Crepe.Feature.ListItem]: {
      bulletIcon: customBulletIcon,
      checkBoxCheckedIcon: customCheckedIcon,
      checkBoxUncheckedIcon: customUncheckedIcon,
    },
  },
}
```

#### LinkTooltip Feature

```typescript
interface LinkTooltipFeatureConfig {
  linkIcon?: string // Custom link icon
  editButton?: string // Custom edit button icon
  removeButton?: string // Custom remove button icon
  confirmButton?: string // Custom confirm button icon
  inputPlaceholder?: string // Placeholder text for link input
  onCopyLink?: (link: string) => void // Callback when link is copied
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.LinkTooltip]: true,
  },
  featureConfigs: {
    [Crepe.Feature.LinkTooltip]: {
      inputPlaceholder: 'Enter URL...',
      onCopyLink: () => console.log('Link copied'),
    },
  },
}
```

#### ImageBlock Feature

```typescript
interface ImageBlockFeatureConfig {
  // Inline image configuration
  inlineUploadButton?: string
  inlineImageIcon?: string
  inlineConfirmButton?: string
  inlineUploadPlaceholderText?: string
  inlineOnUpload?: (file: File) => Promise<string>

  // Block image configuration
  blockUploadButton?: string
  blockImageIcon?: string
  blockCaptionIcon?: string
  blockConfirmButton?: string
  blockCaptionPlaceholderText?: string
  blockUploadPlaceholderText?: string
  blockOnUpload?: (file: File) => Promise<string>

  // Common configuration
  onUpload?: (file: File) => Promise<string>
  proxyDomURL?: string
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.ImageBlock]: true,
  },
  featureConfigs: {
    [Crepe.Feature.ImageBlock]: {
      inlineUploadButton: 'Upload Image',
      blockCaptionPlaceholderText: 'Add image caption...',
      onUpload: async (file) => {
        // Handle file upload
        return 'https://example.com/image.jpg'
      },
    },
  },
}
```

> **Note**: The `onUpload` callback is used for both the click-to-upload button and drag-and-drop file uploads.
> Crepe has a built-in upload plugin (`@milkdown/plugin-upload`) that handles drag-and-drop and paste image uploads.
> When the `ImageBlock` feature is enabled, the upload plugin will use the `onUpload` from the image block configuration to process files and create `image-block` nodes.
> If no custom `onUpload` is provided, files will be converted to local blob URLs by default.

#### BlockEdit Feature

```typescript
interface BlockEditFeatureConfig {
  // Block handle icons
  handleAddIcon?: string
  handleDragIcon?: string

  // Block handle configuration
  blockHandle?: {
    // A function to determine whether the block handle should be shown.
    shouldShow?: (view: EditorView) => boolean
    // A function to configure the offset of the block handle.
    getOffset?: (deriveContext: DeriveContext) => {
      mainAxis?: number
      crossAxis?: number
    }
    // A function to get the position of the block handle.
    getPosition?: (deriveContext: DeriveContext) => DOMRect
    // A function to get the placement of the block handle.
    getPlacement?: (
      deriveContext: DeriveContext
    ) => 'top' | 'bottom' | 'left' | 'right'
    // An array of floating-ui middlewares.
    middleware?: unknown[]
    // Additional options for floating-ui.
    floatingUIOptions?: unknown
    // The root element for the block handle.
    root?: HTMLElement
  }

  // Menu configuration
  buildMenu?: (builder: GroupBuilder<SlashMenuItem>) => void

  // Text group configuration
  textGroup?: {
    label?: string
    text?: {
      label?: string
      icon?: string
    } | null
    h1?: {
      label?: string
      icon?: string
    } | null
    h2?: {
      label?: string
      icon?: string
    } | null
    h3?: {
      label?: string
      icon?: string
    } | null
    h4?: {
      label?: string
      icon?: string
    } | null
    h5?: {
      label?: string
      icon?: string
    } | null
    h6?: {
      label?: string
      icon?: string
    } | null
    quote?: {
      label?: string
      icon?: string
    } | null
    divider?: {
      label?: string
      icon?: string
    } | null
  } | null

  // List group configuration
  listGroup?: {
    label?: string
    bulletList?: {
      label?: string
      icon?: string
    } | null
    orderedList?: {
      label?: string
      icon?: string
    } | null
    taskList?: {
      label?: string
      icon?: string
    } | null
  } | null

  // Advanced group configuration
  advancedGroup?: {
    label?: string
    image?: {
      label?: string
      icon?: string
    } | null
    codeBlock?: {
      label?: string
      icon?: string
    } | null
    table?: {
      label?: string
      icon?: string
    } | null
    math?: {
      label?: string
      icon?: string
    } | null
  } | null
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.BlockEdit]: true,
  },
  featureConfigs: {
    [Crepe.Feature.BlockEdit]: {
      handleAddIcon: customAddIcon,
      handleDragIcon: customDragIcon,
      blockHandle: {
        getPlacement: () => 'left-start',
      },
      textGroup: {
        label: 'Text Blocks',
        text: {
          label: 'Normal Text',
          icon: customTextIcon,
        },
        h1: {
          label: 'Heading 1',
          icon: customH1Icon,
        },
        h2: null,
        h3: null,
        h4: null,
        h5: null,
        h6: null,
      },
      listGroup: {
        label: 'Lists',
        bulletList: {
          label: 'Bullet List',
          icon: customBulletIcon,
        },
        orderedList: null,
        taskList: null,
      },
      advancedGroup: {
        label: 'Advanced',
        image: {
          label: 'Image',
          icon: customImageIcon,
        },
        codeBlock: null,
        table: null,
        math: null,
      },
      buildMenu: (builder) => {
        // Custom menu building logic
      },
    },
  },
}
```

> **Note**: Setting any group or item to `null` will prevent it from being displayed in the menu. This is useful for customizing which options are available to users. For example, setting `h2: null` will hide the H2 heading option, and setting `textGroup: null` will hide the entire text group.

#### Toolbar Feature

```typescript
interface ToolbarFeatureConfig {
  boldIcon?: string
  codeIcon?: string
  italicIcon?: string
  linkIcon?: string
  strikethroughIcon?: string
  latexIcon?: string
  aiIcon?: string // Override only the toolbar's AI button (only renders when AI is enabled and a provider is configured)
  buildToolbar?: (builder: GroupBuilder<ToolbarItem>) => void
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.Toolbar]: true,
  },
  featureConfigs: {
    [Crepe.Feature.Toolbar]: {
      boldIcon: customBoldIcon,
      italicIcon: customItalicIcon,
      buildToolbar: (builder) => {
        // Custom toolbar building logic
      },
    },
  },
}
```

#### TopBar Feature

A fixed toolbar at the top of the editor with heading selector, formatting buttons, insert actions, and block commands. Unlike the Toolbar feature (which appears as a floating tooltip on text selection), the TopBar is always visible. This feature is **disabled by default**.

```typescript
interface TopBarFeatureConfig {
  // Heading selector options
  headingOptions?: HeadingOption[]

  // Icon overrides
  boldIcon?: string
  italicIcon?: string
  strikethroughIcon?: string
  codeIcon?: string
  linkIcon?: string
  imageIcon?: string
  tableIcon?: string
  codeBlockIcon?: string
  mathIcon?: string
  quoteIcon?: string
  hrIcon?: string
  bulletListIcon?: string
  orderedListIcon?: string
  taskListIcon?: string
  chevronDownIcon?: string

  // Custom toolbar building
  buildTopBar?: (builder: GroupBuilder<TopBarItem>) => void
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.TopBar]: true,
  },
  featureConfigs: {
    [Crepe.Feature.TopBar]: {
      // Customize heading options
      headingOptions: [
        { label: 'Text', level: null },
        { label: 'H1', level: 1 },
        { label: 'H2', level: 2 },
        { label: 'H3', level: 3 },
      ],
    },
  },
}
```

The TopBar supports configurable dropdown selectors. The heading selector is built-in, but you can add custom dropdowns via `buildTopBar`:

```typescript
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.TopBar]: true,
  },
  featureConfigs: {
    [Crepe.Feature.TopBar]: {
      buildTopBar: (builder) => {
        builder.addGroup('custom', 'Custom').addItem('font-size', {
          icon: '',
          active: () => false,
          selector: {
            chevronIcon: '<svg>...</svg>',
            activeLabel: (ctx) => '16px',
            options: [
              {
                label: '12px',
                onSelect: (ctx) => {
                  /* set font size */
                },
              },
              {
                label: '14px',
                onSelect: (ctx) => {
                  /* set font size */
                },
              },
              {
                label: '16px',
                onSelect: (ctx) => {
                  /* set font size */
                },
              },
            ],
          },
        })
      },
    },
  },
}
```

The default toolbar groups are:

1. **Heading** - Dropdown selector for Paragraph/H1-H6
2. **Formatting** - Bold, Italic, Strikethrough, Inline Code
3. **List** - Bullet list, Ordered list, Task list
4. **Insert** - Link, Image, Table
5. **Block** - Code block, Math (LaTeX)
6. **More** - Quote, Horizontal rule

#### CodeMirror Feature

```typescript
interface CodeMirrorFeatureConfig {
  extensions?: Extension[] // Custom CodeMirror extensions
  languages?: LanguageDescription[] // Available languages
  theme?: Extension // CodeMirror theme

  // UI customization
  expandIcon?: string
  searchIcon?: string
  clearSearchIcon?: string
  searchPlaceholder?: string
  noResultText?: string

  // Copy button customization
  copyIcon?: string // Custom copy button icon
  copyText?: string // Custom copy button text
  onCopy?: (content: string) => void // Callback when code is copied

  // Rendering customization
  renderLanguage?: (language: string, selected: boolean) => string
  renderPreview?: (
    language: string,
    content: string
  ) => string | HTMLElement | null
  previewToggleIcon?: (previewOnlyMode: boolean) => string
  previewToggleText?: (previewOnlyMode: boolean) => string
  previewLabel?: () => string
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.CodeMirror]: true,
  },
  featureConfigs: {
    [Crepe.Feature.CodeMirror]: {
      searchPlaceholder: 'Search programming language...',
      noResultText: 'No matching language found',
      theme: oneDark, // Import from @codemirror/theme-one-dark
    },
  },
}
```

It's also possible to configure the language list and theme:

```typescript
import { oneDark } from '@codemirror/theme-one-dark'
import { LanguageDescription } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'

const config: CrepeConfig = {
  features: {
    [Crepe.Feature.CodeMirror]: true,
  },
  featureConfigs: {
    [Crepe.Feature.CodeMirror]: {
      theme: oneDark,
      languages: [
        // Only load markdown language
        LanguageDescription.of({
          name: 'Markdown',
          extensions: ['md', 'markdown'],
          load() {
            return import('@codemirror/lang-markdown').then((m) => m.markdown())
          },
        }),
      ],
    },
  },
}
```

To learn which languages are available, you can refer to the [CodeMirror language data](https://github.com/codemirror/language-data).

#### Latex Feature

```typescript
interface LatexFeatureConfig {
  katexOptions?: KatexOptions // KaTeX rendering options
  inlineEditConfirm?: string // Custom confirm icon for inline math
}

// Example:
const config: CrepeConfig = {
  features: {
    [Crepe.Feature.Latex]: true,
  },
  featureConfigs: {
    [Crepe.Feature.Latex]: {
      katexOptions: {
        throwOnError: false,
        displayMode: true,
      },
    },
  },
}
```

#### AI Feature

The AI feature combines streaming input and diff review into a single
workflow. Users supply a `provider` (an async generator that yields
markdown tokens) and Crepe handles the rest: a toolbar entry point, an
instruction palette with built-in suggestions, an inline streaming
indicator, and a floating diff actions panel for accepting or rejecting
the result.

When the user has a text selection, `runAICmd` replaces the selected text
with the AI output. The provider receives the selected text in
`AIPromptContext.selection` for context-aware generation. When the
selection is empty, content is inserted at the cursor position.

```typescript
import { Crepe } from '@milkdown/crepe'
import type { AIFeatureConfig } from '@milkdown/crepe/feature/ai'
import { runAICmd, abortAICmd } from '@milkdown/crepe/feature/ai'
import { callCommand } from '@milkdown/kit/utils'

const crepe = new Crepe({
  root: '#editor',
  features: {
    [Crepe.Feature.AI]: true,
  },
  featureConfigs: {
    [Crepe.Feature.AI]: {
      provider: async function* (context, signal) {
        // Yield markdown tokens from your LLM
      },
      diffReviewOnEnd: true,
      diff: { acceptLabel: 'Yes', rejectLabel: 'No' },
      streaming: { throttleMs: 150 },
      onError: (error) => {
        // Handle AI errors (provider failures, buildContext errors).
        // Defaults to console.error if not provided.
        showToast(error.message)
      },
    } satisfies AIFeatureConfig,
  },
})
await crepe.create()

// Trigger AI programmatically:
crepe.editor.action(
  callCommand(runAICmd.key, { instruction: 'Summarize this' })
)
// Abort:
crepe.editor.action(callCommand(abortAICmd.key))
```

##### UX Surfaces

When `Crepe.Feature.AI` is enabled and a `provider` is configured, the
feature wires up four UI surfaces:

1. **Toolbar AI button** — appears in the selection toolbar's "Function"
   group. Hidden when no `provider` is configured. Override the icon via
   `AIFeatureConfig.aiIcon` (applies everywhere) or
   `ToolbarFeatureConfig.aiIcon` (toolbar only).
2. **Instruction palette** — a combobox dropdown that opens from the
   toolbar button. Users can pick a built-in suggestion, drill into a
   submenu (e.g. _Change tone…_, _Translate…_), or type a free-form
   instruction and submit it as a custom prompt.
3. **Streaming indicator** — an inline pill rendered at the streaming
   insertion point with a spinner, the active-form label (e.g. _Improving
   writing…_), and an _Esc to cancel_ hint.
4. **Diff actions panel** — a floating panel pinned to the bottom of the
   editor while diff review is active for an AI-owned session. Provides
   _Retry_ (re-run the same prompt on the original range), _Reject all_,
   and _Accept all_ buttons. _Accept all_ is also bound to <kbd>Mod</kbd>+<kbd>Enter</kbd>.

##### Localizing Strings & Overriding Icons

Every label and icon used by the AI surfaces is configurable. All of the
following live on `AIFeatureConfig`:

```typescript
interface AIFeatureConfig {
  // ── Instruction palette strings ───────────────────────────────────
  instructionPlaceholder?: string // Default: 'Tell AI what to do with the selection…'
  suggestionsHeaderLabel?: string // Default: 'SUGGESTIONS'
  sendAsPromptHeaderLabel?: string // Default: 'SEND AS PROMPT'
  sendAsPromptLabel?: string // Default: 'Ask AI:'
  submitButtonLabel?: string // aria-label, default: 'Send prompt'
  listboxLabel?: string // aria-label, default: 'AI suggestions'

  // ── Icon overrides ────────────────────────────────────────────────
  aiIcon?: string // Toolbar entry + palette prefix
  sendIcon?: string // Round submit button
  sendPromptIcon?: string // "Ask AI: …" entry icon
  enterKeyIcon?: string // Shared by palette shortcut chip + diff panel
  chevronLeftIcon?: string // Submenu back arrow
  chevronRightIcon?: string // Submenu indicator

  // ── Streaming indicator ───────────────────────────────────────────
  streamingIndicator?: {
    fallbackLabel?: string // Default: 'Generating' (used when runAICmd has no `label`)
    cancelHint?: string // Default: 'Esc to cancel'
  }

  // ── Diff actions panel ────────────────────────────────────────────
  diffActions?: {
    retryLabel?: string // Default: 'Retry'
    rejectAllLabel?: string // Default: 'Reject all'
    acceptAllLabel?: string // Default: 'Accept all'
    retryIcon?: string
    rejectIcon?: string
    acceptIcon?: string
    modSymbol?: string // Default: '⌘' on macOS, 'Ctrl' elsewhere
  }
}
```

##### Customizing Suggestions

The instruction palette ships with built-in suggestions: _Improve
writing_, _Fix grammar & spelling_, _Make shorter_, _Make longer_, plus
_Change tone…_ and _Translate…_ submenus. Customize the list via
`buildAISuggestions`:

```typescript
const config: AIFeatureConfig = {
  buildAISuggestions: (builder) => {
    // The builder is pre-populated with the defaults; mutate freely.
    builder.removeItem('grammar') // drop a built-in
    builder.addItem('summarize', {
      icon: '<svg>…</svg>',
      label: 'Summarize',
      streamingLabel: 'Summarizing', // shown in the streaming indicator
      prompt: 'Summarize this in one paragraph.',
    })

    // Add a new submenu with its own items
    builder.addSubmenu(
      'audience',
      {
        icon: '<svg>…</svg>',
        label: 'Rewrite for audience…',
        title: 'Rewrite for audience',
        searchPlaceholder: 'Search audiences…',
      },
      (sub) => {
        sub.addItem('beginner', {
          icon: '<svg>…</svg>',
          label: 'Beginners',
          prompt: 'Rewrite this for a beginner audience.',
        })
      }
    )

    // To start from scratch instead, call builder.clear() first.
  },
}
```

The submitted prompt is wrapped in an `AIPromptContext` (with the
serialized document and any selection) and passed to your `provider`.

##### Triggering Programmatically

```typescript
import { runAICmd, abortAICmd } from '@milkdown/crepe/feature/ai'
import { callCommand } from '@milkdown/kit/utils'

// `label` is the active-form text shown in the streaming indicator.
crepe.editor.action(
  callCommand(runAICmd.key, {
    instruction: 'Translate this to French',
    label: 'Translating to French',
  })
)

// Abort the in-flight session. `keep: true` preserves the partial
// streamed output; `keep: false` (default) discards it.
crepe.editor.action(callCommand(abortAICmd.key, { keep: true }))
```

##### Built-in Providers

Crepe ships two ready-made `AIProvider` factories so you don't have to
hand-roll SSE parsing, system prompts, or auth headers. Both live under
their own subpaths and have no SDK dependencies (just `fetch`).

```typescript
import { createOpenAIProvider } from '@milkdown/crepe/llm-providers/openai'
import { createAnthropicProvider } from '@milkdown/crepe/llm-providers/anthropic'

// Server-side shape (no browser; `apiKey` reads from a real secret).
// In the browser, see "Deployment modes" below — passing an `apiKey`
// from a page or Worker throws unless you explicitly opt in.
const openai = createOpenAIProvider({
  apiKey: '<your-openai-api-key>',
  model: 'gpt-4o-mini',
})

const anthropic = createAnthropicProvider({
  apiKey: '<your-anthropic-api-key>',
  model: 'claude-sonnet-4-5',
})
```

There is no "secure" way to embed an API key in a browser bundle —
build-time substitutions like Vite's `import.meta.env.VITE_*` end up
as plain strings in the shipped JavaScript and are visible to anyone
who can open DevTools. The two safe deployment modes are:

- **BYOK**: each user provides their own key (typed into your UI,
  read from desktop-app keychain, etc.) and accepts the exposure
  for their own account. Set `dangerouslyAllowBrowser: true`.
- **Backend proxy**: omit `apiKey` entirely and point `baseURL` at
  your own server, which holds the real key and forwards requests.
  This is the recommended pattern for multi-user web apps.

`process.env` only works in Node/SSR; it won't be defined in a typical
browser build.

Both providers send a default system prompt that asks for raw markdown
output (no preambles, no surrounding code fences) and assemble the user
message from `AIPromptContext`:

```
<document>
{full markdown}
</document>

<selection>            ← only when non-empty
{selected markdown}
</selection>

<instruction>
{user instruction}
</instruction>
```

###### Deployment modes

Pick the config combination that matches where the API key actually lives:

```typescript
// 1. Desktop / BYOK (each user supplies their own key)
//    The key is in the page; opt in explicitly.
createOpenAIProvider({
  apiKey: userKey,
  model: 'gpt-4o-mini',
  dangerouslyAllowBrowser: true,
})

// 2. Production: route through your own backend.
//    No `apiKey`; your server attaches the real key. The browser
//    sends a session token instead. No `dangerouslyAllowBrowser`
//    needed because the API key never reaches the client.
createAnthropicProvider({
  baseURL: '/api/anthropic',
  headers: { Authorization: `Bearer ${sessionToken}` },
  model: 'claude-sonnet-4-5',
})

// 3. Server-side / SSR
//    No browser, so no opt-in needed.
createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
})
```

Setting `apiKey` from the main browser thread or from a Worker without
`dangerouslyAllowBrowser: true` throws — the provider refuses to leak
your key into a context where any visitor could read it.

###### Shared configuration

The two providers share these fields (the actual exported types are
`OpenAIProviderConfig` and `AnthropicProviderConfig`; the interface
below is illustrative — there is no `BaseProviderConfig` public
export to import directly):

```typescript
// Shape shared by `OpenAIProviderConfig` and `AnthropicProviderConfig`
interface BaseProviderConfig {
  apiKey?: string
  baseURL?: string // defaults to the provider's official endpoint
  headers?: Record<string, string>
  model: string
  systemPrompt?: string | null // string → use as-is (incl. ''); null → omit; undefined → default
  dangerouslyAllowBrowser?: boolean
}
```

`systemPrompt` semantics: `undefined` keeps the markdown-only default,
`null` sends no system message at all, and any string (including `''`)
replaces the default verbatim.

###### Provider-specific options

```typescript
// OpenAI: any chat-completions body fields (temperature, top_p, etc.)
// can go in `body`. `buildMessages` lets you fully customize the
// messages array — the defaults are passed in so you can wrap them.
// `defaults.systemPrompt` is `string | null`: `null` means the user
// asked to omit the system message, so don't coerce it to ''.
createOpenAIProvider({
  apiKey,
  model: 'gpt-4o-mini',
  body: { temperature: 0.2 },
  buildMessages: (context, defaults) => [
    ...(defaults.systemPrompt !== null
      ? [{ role: 'system' as const, content: defaults.systemPrompt }]
      : []),
    { role: 'user', content: defaults.userMessage },
  ],
})

// Anthropic: `maxTokens` (default 4096), `anthropicVersion` (default
// '2023-06-01'), and any `/v1/messages` body fields via `body`.
// `buildMessages` returns `{ system, messages }` since Anthropic puts
// the system prompt in a top-level field rather than the messages array.
createAnthropicProvider({
  apiKey,
  model: 'claude-sonnet-4-5',
  maxTokens: 2048,
  body: { temperature: 0.5 },
})
```

###### CORS note for direct browser calls

`api.openai.com/v1/chat/completions` doesn't return the
`Access-Control-Allow-Origin` (ACAO) header that browsers require for
cross-origin requests, and
`api.anthropic.com/v1/messages` requires the
`anthropic-dangerous-direct-browser-access` header (which the Anthropic
provider sets automatically when `dangerouslyAllowBrowser: true`).
Direct browser → provider calls work in desktop apps (no CORS) but
generally fail from regular web pages. The proxy mode above (`baseURL`
pointing at your own backend) sidesteps CORS entirely and is the
recommended deployment pattern.

See [@milkdown/plugin-diff](./plugin-diff.md) and
[@milkdown/plugin-streaming](./plugin-streaming.md) for the underlying
plugin APIs.

## Usage

### Using Crepe Editor

The `Crepe` class provides a high-level interface with all features enabled by default:

```typescript
import { Crepe } from '@milkdown/crepe'

const editor = new Crepe({
  root: '#editor', // DOM element or selector
  features: {
    [Crepe.Feature.Toolbar]: true,
    [Crepe.Feature.Latex]: true,
  },
  featureConfigs: {
    [Crepe.Feature.Placeholder]: {
      text: 'Start writing...',
      mode: 'block',
    },
  },
  defaultValue: '# Hello World',
})

// Get markdown content
const markdown = editor.getMarkdown()

// Set readonly mode
editor.setReadonly(true)

// Listen to editor events
editor.on((listener) => {
  listener.markdownUpdated((ctx, markdown, prevMarkdown) => {
    // Handle updates
  })
})
```

### Using CrepeBuilder

The `CrepeBuilder` class provides a more flexible way to build your editor by manually adding features. This approach is particularly useful for optimizing bundle size since you only include the features you actually need:

```typescript
import { CrepeBuilder } from '@milkdown/crepe/builder'
import { blockEdit } from '@milkdown/crepe/feature/block-edit'
import { toolbar } from '@milkdown/crepe/feature/toolbar'
import { topBar } from '@milkdown/crepe/feature/top-bar'

// You may also want to import styles by feature
import '@milkdown/crepe/theme/common/prosemirror.css'
import '@milkdown/crepe/theme/common/reset.css'
import '@milkdown/crepe/theme/common/block-edit.css'
import '@milkdown/crepe/theme/common/toolbar.css'
import '@milkdown/crepe/theme/common/top-bar.css'

// And introduce the theme
import '@milkdown/crepe/theme/crepe.css'

const builder = new CrepeBuilder({
  root: '#editor',
  defaultValue: '# Hello World',
})

// Add features manually
builder.addFeature(blockEdit).addFeature(toolbar).addFeature(topBar)

// Create the editor
const editor = await builder.create()

// Get markdown content
const markdown = builder.getMarkdown()

// Set readonly mode
builder.setReadonly(true)

// Listen to editor events
builder.on((listener) => {
  listener.markdownUpdated((ctx, markdown, prevMarkdown) => {
    // Handle updates
  })
})
```

The `CrepeBuilder` is useful when you want to:

- Reduce bundle size by only including the features you need
- Have more control over which features are added and in what order
- Add custom features or plugins
- Configure features individually with their specific configurations

This approach allows for better tree-shaking and results in a smaller bundle size compared to using the full `Crepe` editor with all features enabled.

## Themes

Crepe comes with several built-in themes that can be imported:

```typescript
// Light themes
import '@milkdown/crepe/theme/crepe.css'
import '@milkdown/crepe/theme/nord.css'
import '@milkdown/crepe/theme/frame.css'

// Dark themes
import '@milkdown/crepe/theme/crepe-dark.css'
import '@milkdown/crepe/theme/nord-dark.css'
import '@milkdown/crepe/theme/frame-dark.css'
```

## API Reference

 #### enum `CrepeFeature`
   The crepe editor feature flags.
   Most features are enabled by default; `TopBar` and `AI` are opt-in.
   See `defaultFeatures` for the per-flag default.

   * **`CodeMirror`**\
     Syntax highlighting and editing for code blocks with language support, theme customization, and preview capabilities.

   * **`ListItem`**\
     Support for bullet lists, ordered lists, and todo lists with customizable icons and formatting.

   * **`LinkTooltip`**\
     Enhanced link editing and preview with customizable tooltips, edit/remove actions, and copy functionality.

   * **`Cursor`**\
     Enhanced cursor experience with drop cursor and gap cursor for better content placement.

   * **`ImageBlock`**\
     Image upload and management with resizing, captions, and support for both inline and block images.

   * **`BlockEdit`**\
     Drag-and-drop block management and slash commands for quick content insertion and organization.

   * **`Toolbar`**\
     Formatting toolbar for selected text with customizable icons and actions.

   * **`Placeholder`**\
     Document or block level placeholders to guide users when content is empty.

   * **`Table`**\
     Full-featured table editing with row/column management, alignment options, and drag-and-drop functionality.

   * **`Latex`**\
     Mathematical formula support with both inline and block math rendering using KaTeX.

   * **`TopBar`**\
     Fixed top toolbar with heading selector, formatting buttons, insert actions, and block commands.

   * **`AI`**\
     AI-assisted editing: streaming input, diff review, and provider integration.

#### class Crepe extends CrepeBuilder



The crepe editor class.

 * `new `**`Crepe`**`(CrepeConfig = {})`\
   The constructor of the crepe editor.
   You can pass configs to the editor to configure the editor.
   Calling the constructor will not create the editor, you need to call `create` to create the editor.

 * `static `**`Feature`**`: typeof CrepeFeature`\
   This is an alias for the `CrepeFeature` enum.


#### interface CrepeConfig

 extends `CrepeBuilderConfig`

The crepe editor configuration.

 * **`features`**`?: Partial`\
   Enable/disable specific features.

 * **`featureConfigs`**`?: {cursor?: Partial, list-item?: Partial, link-tooltip?: Partial, image-block?: Partial, block-edit?: instantiated, placeholder?: Partial, toolbar?: Partial, code-mirror?: Partial, table?: Partial, latex?: Partial, top-bar?: Partial}`\
   Configure individual features.

    * **`ai`**`?: interface`

       * **`provider`**`?: fn(context: {document: string, selection: string, instruction: string}, signal: AbortSignal) → AsyncIterable`\
         Async generator that yields markdown tokens. Required for
         `runAICmd`; without it the command returns false. The diff and
         streaming plugins load either way, so the feature can be enabled
         without a provider for diff-only or manual-streaming use cases.

       * **`buildContext`**`?: fn(ctx: Ctx, instruction: string) → {document: string, selection: string, instruction: string}`\
         Optional. Assemble the context passed to `provider`.
         Defaults to serializing the document (+ selection if any) as markdown.

       * **`diffReviewOnEnd`**`?: boolean`\
         Whether to enter diff review after streaming completes. Default true.

       * **`diff`**`?: {acceptLabel?: string, rejectLabel?: string, customBlockTypes?: string[], ignoreAttrs?: Record}`\
         Pass-through config for the diff plugin.

       * **`streaming`**`?: Partial`\
         Pass-through config for the streaming plugin.
         `diffReviewOnEnd` is excluded here because it's controlled by
         `AIFeatureConfig.diffReviewOnEnd` at the AI layer — setting it on
         both would be confusing.

       * **`onError`**`?: fn(error: MilkdownError)`\
         Called when an error occurs during AI processing.
         Receives a `MilkdownError` with code `aiProviderError` or
         `aiBuildContextError`.

       * **`aiIcon`**`?: string`\
         Custom icon for both the toolbar AI entry point and the prefix slot
         inside the instruction input. The toolbar feature can override this
         for just the toolbar button via `ToolbarFeatureConfig.aiIcon`.

       * **`instructionPlaceholder`**`?: string`\
         Placeholder text for the AI instruction input on the main view.
         @default DEFAULT_INSTRUCTION_PLACEHOLDER

       * **`suggestionsHeaderLabel`**`?: string`\
         Label for the suggestions section header.
         @default DEFAULT_SUGGESTIONS_HEADER_LABEL

       * **`sendAsPromptHeaderLabel`**`?: string`\
         Label for the free-text prompt section header.
         @default DEFAULT_SEND_AS_PROMPT_HEADER_LABEL

       * **`sendAsPromptLabel`**`?: string`\
         Prefix text for the free-text prompt entry, before the quoted input.
         @default DEFAULT_SEND_AS_PROMPT_LABEL

       * **`submitButtonLabel`**`?: string`\
         Accessible name for the round submit button in the input pill.
         Surfaced as `aria-label` so screen readers don't announce the
         icon-only button as "unlabeled".
         @default DEFAULT_SUBMIT_BUTTON_LABEL

       * **`listboxLabel`**`?: string`\
         Accessible name announced for the suggestion list (`role="listbox"`)
         inside the palette. Localize alongside the other strings.
         @default DEFAULT_LISTBOX_LABEL

       * **`sendIcon`**`?: string`\
         Icon for the round submit button in the input pill.
         Default: an upward arrow.

       * **`sendPromptIcon`**`?: string`\
         Icon shown next to the "Ask AI: …" entry. Default: paper-plane.

       * **`enterKeyIcon`**`?: string`\
         Icon used in the keyboard shortcut chip on the prompt entry.
         Default: enter-key arrow.

       * **`chevronLeftIcon`**`?: string`\
         Icon for the back arrow at the top of a submenu. Default: chevron-left.

       * **`chevronRightIcon`**`?: string`\
         Icon shown on the right of submenu entries. Default: chevron-right.

       * **`buildAISuggestions`**`?: fn(builder: {#nodes: ({kind: "item", id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}} | {kind: "submenu", id: string, node: {def: {icon: string, label: string, title: string, searchPlaceholder: string}, items: Map}})[], addItem: fn(id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}) → Object, removeItem: fn(id: string) → Object, getItem: fn(id: string) → {icon: string, label: string, streamingLabel?: string, prompt: string} | undefined, clear: fn() → Object, build: fn() → {main: ({kind: "item", id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}} | {kind: "submenu", id: string, def: {icon: string, label: string, title: string, searchPlaceholder: string}})[], submenus: Record}, #removeById: fn(id: string)})`\
         Customize the suggestion list. The builder is pre-populated with the
         built-in suggestions; the callback can add, remove, or replace any
         item or submenu. To start from scratch, call `builder.clear()` first.

          * **`builder`**`: {#nodes: ({kind: "item", id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}} | {kind: "submenu", id: string, node: {def: {icon: string, label: string, title: string, searchPlaceholder: string}, items: Map}})[], addItem: fn(id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}) → Object, removeItem: fn(id: string) → Object, getItem: fn(id: string) → {icon: string, label: string, streamingLabel?: string, prompt: string} | undefined, clear: fn() → Object, build: fn() → {main: ({kind: "item", id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}} | {kind: "submenu", id: string, def: {icon: string, label: string, title: string, searchPlaceholder: string}})[], submenus: Record}, #removeById: fn(id: string)}`

             * **`addSubmenu`**`(id: string, def: {icon: string, label: string, title: string, searchPlaceholder: string}, build?: fn(sub: {addItem: fn(id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}) → Object, removeItem: fn(id: string) → Object, getItem: fn(id: string) → {icon: string, label: string, streamingLabel?: string, prompt: string} | undefined, clear: fn() → Object})) → Object`\
               Add a submenu. Populate items via the optional `build` callback,
               or call `getSubmenu(id)` afterward. Returns `this` so calls can be
               chained at the parent level alongside `addItem`.

             * **`getSubmenu`**`(id: string) → {addItem: fn(id: string, item: {icon: string, label: string, streamingLabel?: string, prompt: string}) → Object, removeItem: fn(id: string) → Object, getItem: fn(id: string) → {icon: string, label: string, streamingLabel?: string, prompt: string} | undefined, clear: fn() → Object} | undefined`\
               Return a builder that mutates the submenu's items in place.
               Multiple calls return distinct builder objects backed by the same
               underlying node, so changes are always visible.

       * **`streamingIndicator`**`?: interface`\
         Customize the inline streaming indicator pill shown while AI runs.

          * **`fallbackLabel`**`?: string`\
            Fallback active-form label when the current session has none set
            (i.e., `runAICmd` was called without a `label`).
            @default DEFAULT_STREAMING_FALLBACK_LABEL

          * **`cancelHint`**`?: string`\
            Hint text shown after the label, suggesting how to cancel.
            @default DEFAULT_STREAMING_CANCEL_HINT

       * **`diffActions`**`?: interface`\
         Customize the floating diff actions panel (Retry / Reject all /
         Accept all) that appears once streaming hands off to diff review.

          * **`retryLabel`**`?: string`\
            @default DEFAULT_DIFF_ACTIONS_RETRY_LABEL

          * **`rejectAllLabel`**`?: string`\
            @default DEFAULT_DIFF_ACTIONS_REJECT_ALL_LABEL

          * **`acceptAllLabel`**`?: string`\
            @default DEFAULT_DIFF_ACTIONS_ACCEPT_ALL_LABEL

          * **`retryIcon`**`?: string`\
            Icon for the Retry button. Default: refresh icon.

          * **`rejectIcon`**`?: string`\
            Icon for the Reject all button. Default: 'X' icon.

          * **`acceptIcon`**`?: string`\
            Icon for the Accept all button. Default: checkmark icon.

          * **`modSymbol`**`?: string`\
            Modifier key glyph shown alongside the enter-key icon. Set to
            'Ctrl' on non-Mac platforms if you need to disambiguate.
            @default DEFAULT_DIFF_ACTIONS_MOD_SYMBOL


#### class CrepeBuilder



The crepe builder class.
This class allows users to manually add features to the editor.

 * `new `**`CrepeBuilder`**`(CrepeBuilderConfig = {})`\
   The constructor of the crepe builder.
   You can pass configs to the builder to configure the editor.

 * **`addFeature`**`<T extends CrepeFeature>(feature: fn(editor: Editor, config?: NonNullable), config?: NonNullable) → CrepeBuilder`\
   **`addFeature`**`<C>(feature: fn(editor: Editor, config?: NonNullable), config?: NonNullable) → CrepeBuilder`\
   Add a feature to the editor.

 * **`create`**`() → Promise`\
   Create the editor.

 * **`destroy`**`() → Promise`\
   Destroy the editor.

 * **`editor`**`: Editor`\
   Get the milkdown editor instance.

 * **`readonly`**`: boolean`\
   Get the readonly state of the editor.

 * **`setReadonly`**`(value: boolean) → CrepeBuilder`\
   Set the readonly mode of the editor.

 * **`getMarkdown`**`() → string`\
   Get the markdown content of the editor.

 * **`on`**`(fn: fn(api: ListenerManager)) → CrepeBuilder`\
   Register event listeners.


#### interface CrepeBuilderConfig



The crepe builder configuration.

 * **`root`**`?: Node | string | null`\
   The root element for the editor.
   Supports both DOM nodes and CSS selectors,
   If not provided, the editor will be appended to the body.

 * **`defaultValue`**`?: DefaultValue`\
   The default value for the editor.


 #### useCrepe `(ctx: Ctx) → CrepeBuilder`
   The crepe editor context.
   You can use this context to access the crepe editor instance within Milkdown plugins.
   ```ts
   import { crepeCtx } from '@milkdown/crepe'
   const plugin = (ctx: Ctx) => {
     return () => {
       const crepe = useCrepe(ctx)
       crepe.setReadonly(true)
     }
   }
   ```


 #### useCrepeFeatures `(ctx: Ctx) → Slice`
   Check the enabled FeatureFlags
   ```ts
   import { useCrepeFeatures } from '@milkdown/crepe'
   const plugin = (ctx: Ctx) => {
     const features = useCrepeFeatures(ctx)
     if (features.get().includes(CrepeFeature.CodeMirror)) {
       // Do something with CodeMirror
     }
   }
