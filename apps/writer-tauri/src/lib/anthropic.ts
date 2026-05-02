// Singleton Anthropic SDK client. The actual HTTP request goes through
// our Tauri proxy (see tauriFetch.ts) — the apiKey here is unused because
// the proxy injects the OAuth Bearer token in Rust.

import Anthropic from '@anthropic-ai/sdk'
import { tauriFetch } from './tauriFetch'

export const anthropic = new Anthropic({
  apiKey: 'unused',
  baseURL: 'https://api.anthropic.com',
  fetch: tauriFetch,
  // SDK refuses to run in a browser-like environment by default — our
  // proxy makes that safe (token never reaches JS).
  dangerouslyAllowBrowser: true,
})
