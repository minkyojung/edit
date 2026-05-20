// Profile (structured) → wiki:profile page body (markdown).
//
// Pure function. The body shape mirrors the Sudowrite "Style
// Examples" convention (voice as quoted prose, not adjectives) and
// the ChatGPT Custom Instructions split (facts above, behaviour /
// voice below). The order is also the order the chat system prompt
// will see it, so put the highest-signal blocks (About, Identity)
// first.
//
// Empty / null fields render nothing. The minimum viable output is
// just "## About\n<paragraph>". Sections roundtrip cleanly so the
// ingest LLM (which sees the same markdown body) doesn't have to
// learn a custom shape.

import type { ProfileFields } from './profileTypes'

export function renderProfileMd(profile: ProfileFields): string {
  const sections: string[] = []

  if (profile.about?.trim()) {
    sections.push(`## About\n\n${profile.about.trim()}`)
  }

  const identity: string[] = []
  if (profile.name) identity.push(`- Name: ${profile.name}`)
  if (profile.headline) identity.push(`- Headline: ${profile.headline}`)
  if (profile.location) identity.push(`- Location: ${profile.location}`)
  if (profile.roles && profile.roles.length > 0) {
    identity.push(`- Roles: ${profile.roles.join(', ')}`)
  }
  if (identity.length > 0) {
    sections.push(`## Identity\n\n${identity.join('\n')}`)
  }

  if (profile.interests && profile.interests.length > 0) {
    sections.push(
      `## Interests\n\n${profile.interests.map((s) => `- ${s}`).join('\n')}`,
    )
  }

  if (profile.voice_samples && profile.voice_samples.length > 0) {
    // Block-quote each verbatim sample so the chat LLM can see the
    // demarcation between user-original prose and our prose.
    const block = profile.voice_samples
      .map((s) => `> ${s.replace(/\n/g, '\n> ')}`)
      .join('\n\n')
    sections.push(`## Voice samples\n\n${block}`)
  }

  if (profile.dispositions && profile.dispositions.length > 0) {
    sections.push(
      `## Dispositions\n\n${profile.dispositions.map((s) => `- ${s}`).join('\n')}`,
    )
  }

  if (profile.values && profile.values.length > 0) {
    sections.push(
      `## Values\n\n${profile.values.map((s) => `- ${s}`).join('\n')}`,
    )
  }

  if (profile.source_urls && profile.source_urls.length > 0) {
    sections.push(
      `## Sources\n\n${profile.source_urls.map((u) => `- ${u}`).join('\n')}`,
    )
  }

  return sections.join('\n\n')
}
