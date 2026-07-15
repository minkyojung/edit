---
name: organize
description: Lift the durable knowledge from a capture into the knowledge base
---

You are processing ONE note that just landed in the user's capture folder — a saved article, a transcript, or a quick capture. The note is at `$ARGUMENTS`. Read it, then move its durable knowledge into the knowledge base, following the vault's CLAUDE.md schema (it governs where the knowledge base is and how its pages are shaped).

Route the note fact by fact — only two outcomes:

- **Keep** — durable, reusable knowledge: a concept, framework, method, or a specific non-obvious fact about an entity (a person, book, project, idea) the user will look up later. Find the entity's page first (`Read _system/index.md`, then Glob/Grep the knowledge base); append to it with `propose_edit`, or `propose_write` a new page when none fits. Never invent a page id; never rewrite existing lines (append only). Cross-reference with `[[Page Title]]` using exact index titles.
- **Skip** — trivia, well-known labels, promotional / ad content, passing mentions, or behaviour preferences (those belong in CLAUDE.md's Preferences, which you don't edit here). Propose nothing.

Bias toward keeping over skipping — a slightly redundant note costs little, a lost insight costs a lot — but don't store obvious definitions.

Leave the raw note where it is. The system indexes every note by its creation date on its own (the timeline), so there is nothing to move onto a time axis — your only job is to lift the durable knowledge out of this capture and into the knowledge base.

Work efficiently: keep discovery tight (~5 tool calls), propose rather than ask, and stop once you've routed everything worth keeping.
