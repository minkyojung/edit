// Shared types for the chat surface (threads + turns).
// Stored in the document's Y.Doc so they sync across devices via Hocuspocus.

export interface ThreadMeta {
  id: string
  title: string                    // empty until Haiku titler fills it in
  createdAt: number
  updatedAt: number
  archived: boolean
  archivedAt?: number              // for archive popover sort (newest first)
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string                  // markdown
  ts: number
  attachments?: Attachment[]
  toolCalls?: ToolCall[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
  /** Accumulated thinking-block text. Rendered as a collapsible capsule. */
  thinking?: string
}

export type Attachment =
  | { type: 'selection'; from: number; to: number; preview: string }

export interface ToolCall {
  id: string                       // Anthropic tool_use_id
  name: string
  input: unknown
  result?: { ok: true; markId: string } | { ok: false; reason: string }
}

export const MAX_ACTIVE_THREADS = 5
