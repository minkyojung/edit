---
name: organize
description: Route an inbox capture into the wiki / daily, then file it out of the inbox
---

You are processing ONE note that just landed in the user's inbox — a saved article, a transcript, or a quick capture. The note is at `$ARGUMENTS`. Read it, then route its content fact by fact, proposing edits directly with your tools (propose_edit / propose_multi_edit / propose_write). The CLAUDE.md schema above governs vault layout and formatting; this block adds the routing decision.

THE ANCHOR — read this first. Everything you do for this note hangs off ONE date: the note's own creation date. When you Read the note you will see its frontmatter; take the `createdAt` field and use its calendar date in `YYYY-MM-DD` form as the anchor for BOTH the daily trace and the filing below. This is the whole point: every capture is tied to the day it was created, so the vault grows one reliable time axis. NEVER anchor on a date written in the note's BODY — a publish date, an event date, a date someone mentioned are subject matter, not the filing date. If the note has no readable `createdAt`, do NOT move it — leave it in the inbox.

Three destinations, decided fact by fact:
- **wiki** — durable, reusable knowledge: a concept, framework, method, or a specific non-obvious fact about an entity (a person, book, project, idea) the user will look up later. This is the timeless knowledge graph — it is NOT anchored to the date. Find the entity's page first (read `_system/index.md`, then Glob/Grep `wiki/`); append to it with propose_edit, or propose_write a new `wiki/<Title>.md` when none fits. Never invent a page id; never rewrite existing lines (append only). Cross-reference with [[Page Title]] using exact index titles.
- **daily** — what the user DID, an opinion or takeaway they expressed, or a dated event. Add ONE short bullet (the user's voice) to the note's OWN daily — `daily/<createdAt>.md` (the createdAt date, NOT today) — by APPENDING with `propose_edit`: anchor on the file's last line and put your bullet after it. Reference this note in the bullet (an [[link]] by its title) so the daily reads as that day's index into what was captured. NEVER use `propose_write` on a daily that already has content: it replaces the whole journal. The daily is the user's own writing — only ever add lines, never rewrite or remove existing ones. (If `daily/<createdAt>.md` doesn't exist yet, the host creates it when you propose to that path — just target it.)
- **skip** — trivia, well-known labels, promotional / ad content, passing mentions, or behaviour preferences (those belong in CLAUDE.md, which you don't edit here). Propose nothing for these.

A typical capture produces BOTH: a few durable ideas → wiki, plus a couple of "did / concluded" lines → its daily. Bias toward keeping over skipping — a slightly redundant note costs little, a lost insight costs a lot — but don't store obvious definitions.

Then FILE the raw note onto the time axis: once its durable content is in the wiki (and any dated lines in its daily), move the note under its creation day. Restate the `createdAt` date you read, then call `move_note` with the note's path and the folder `daily/<createdAt>` (e.g. `daily/2026-07-04`) — the sub-note folder for that day. The move is applied immediately and is reversible, so don't ask. But only move when you're confident: if the note was all skip, or you couldn't read a `createdAt`, LEAVE it in the inbox — never force a move, never guess the date from the body, and never route it back into the capture folder.

Work efficiently: keep discovery tight (~5 tool calls), propose rather than ask, and stop once you've routed everything worth keeping.
