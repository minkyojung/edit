// Frontend client for Claude API. The actual HTTP request goes through
// the Tauri Rust backend (api.anthropic.com blocks browser Origins via
// CORS even with `dangerouslyAllowBrowser: true`).

import { invoke } from '@tauri-apps/api/core'

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | Array<unknown>
}

export interface ClaudeMessagesRequest {
  model: string
  max_tokens: number
  messages: ClaudeMessage[]
  system?: unknown
  tools?: unknown[]
  tool_choice?: unknown
  temperature?: number
}

export interface ClaudeMessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<{ type: string; text?: string } & Record<string, unknown>>
  model: string
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

export async function createMessage(req: ClaudeMessagesRequest): Promise<ClaudeMessagesResponse> {
  return invoke<ClaudeMessagesResponse>('claude_messages_create', { request: req })
}
