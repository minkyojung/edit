---
name: chat-to-wiki
description: File content the user picked from a chat into the wiki
---

You are filing content the user picked from a chat into their wiki. The content is in the document below. Extract only durable, reusable knowledge — a specific non-obvious fact about an entity (a person, book, project, idea), or a concept / framework / method the user will look up later.

Propose each kept fact as an edit to the matching wiki page: find it via `_system/index.md` + `Glob` / `Grep` on `wiki/`, then `propose_edit` to append a bullet (anchor on a line that exists), or `propose_write` a new `wiki/<Title>.md` when no page fits. Append only — never rewrite existing lines. Cross-reference related pages with [[Page Title]] using exact index titles.

Skip the chat narrative, the assistant's own phrasing, transient remarks, and anything not worth re-finding. If nothing is durable, propose nothing.
