// Trim a Claude model identifier into the short family + version
// label the app uses everywhere — "claude-haiku-4-5-20251001" →
// "haiku 4.5", "claude-3-5-sonnet-20241022" → "sonnet 3.5",
// "claude-opus-4-7" → "opus 4.7".
//
// proof-sdk and @anthropic-ai/sdk both carry the raw model id (date
// suffix, version, etc.); none of them expose a display label, so
// this is the single place that decides what the user sees.
//
// Anthropic uses two naming conventions in the wild:
//   - "claude-{family}-{major}-{minor}[-{date}]" (current, 4.x line)
//   - "claude-{major}-{minor}-{family}[-{date}]" (legacy, 3.x line)
// Both regexes below cover those shapes; anything else falls back
// to the bare family name, then to the raw input.

const FAMILY = /(haiku|sonnet|opus)/i
const NEW_STYLE = /(haiku|sonnet|opus)-(\d+)(?:-(\d+))?/i
const OLD_STYLE = /(\d+)(?:-(\d+))?-(haiku|sonnet|opus)/i

export function formatModel(model: string): string {
  const newStyle = NEW_STYLE.exec(model)
  if (newStyle) {
    const [, family, major, minor] = newStyle
    return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
  }

  const oldStyle = OLD_STYLE.exec(model)
  if (oldStyle) {
    const [, major, minor, family] = oldStyle
    return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
  }

  const family = FAMILY.exec(model)
  if (family) return family[1].toLowerCase()

  return model
}
