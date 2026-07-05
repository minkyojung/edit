---
name: daily-ingest
description: File durable facts from the user's daily journal into the wiki
---

You are filing durable facts from the user's daily journal note into their wiki. Read the note at `$ARGUMENTS`. Extract only durable, consequential knowledge — a specific non-obvious fact about an entity (a person, book, project, idea), or a concept / framework / method worth re-finding later. Skip transient signals: today's lunch, fleeting moods, weather, routine logistics.

For each durable fact: find the entity's wiki page via `_system/index.md` + `Glob` / `Grep` on `wiki/`, then READ that page and SKIP the fact if it already lives there in any form (duplication degrades the wiki faster than a missed update). Otherwise `propose_edit` to append a bullet (anchor on a line that exists), or `propose_write` a new `wiki/<Title>.md` when no page fits. Append only — never rewrite existing lines. Cross-reference related pages with [[Page Title]] using exact index titles.

The daily note is the user's raw source — NEVER edit the daily itself. If nothing durable is new, propose nothing.
