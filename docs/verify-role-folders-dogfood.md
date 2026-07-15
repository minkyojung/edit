# Dogfood checklist — role folders (U12 Layer B)

Verifies that moving the knowledge-base + capture folders into user
settings (U11) didn't change how the AI behaves — it still finds, files,
and organizes knowledge, and it now follows the *configured* folder
instead of a hard-coded `wiki/` / `inbox/`.

**Why manual:** whether the model *obeys* its folder instructions can
only be observed by running it — Layer A (`systemPrompt.test.ts`) already
proves the correct instruction reaches the model deterministically. This
is the "does it actually behave" half. ~5 minutes.

**Where the AI-facing files live** (hidden from the sidebar — open in
Finder / an external editor to inspect): `<vault>/_system/index.md`,
`<vault>/_system/timeline.md`.

---

## Part 1 — defaults (`wiki` / `inbox`)

Fresh or existing vault with knowledge base = `wiki`, capture = `inbox`
(Settings ▸ Files & Notes).

- [ ] **1. Query.** Ask the chat: *"What do I know about &lt;a topic that has a
      wiki page&gt;?"* → it reads the base and answers, citing `[[Page]]`.
      (Small talk / general questions should NOT trigger a file read.)
- [ ] **2. Capture → organize.** Put a note with a fact worth keeping in
      `inbox/`, run Organize. → the durable knowledge lands in a page
      under **`wiki/`**, and the raw note is filed out of `inbox/`.
- [ ] **3. Derived views.** Open `_system/index.md` → the new/updated page
      shows under the `## wiki/ — knowledge base` section. Open
      `_system/timeline.md` → today's note appears under today's date.

## Part 2 — re-pointed knowledge base

Settings ▸ Files & Notes ▸ **Knowledge base folder** → change `wiki` →
`notes` (or any folder). Then, in a NEW chat turn (the setting is injected
per-turn):

- [ ] **4. Routing follows the setting.** Repeat step 2 (capture →
      organize). → durable knowledge now lands under **`notes/`**, NOT
      `wiki/`. This is the whole point: no hard-coded path.
- [ ] **5. Index re-labels.** Open `_system/index.md` → the `notes/`
      section is now tagged `— knowledge base` and sorted to the top;
      `wiki/` (if it still has pages) is a plain section.
- [ ] **6. No regression.** Ask a query as in step 1 → it still finds and
      cites knowledge correctly from the new location.

## Part 3 — onboarding mapping (fresh vault)

- [ ] **7. Roles step.** Start onboarding with a new/empty folder → after
      picking it, the **"Where does what go?"** step appears with two
      dropdowns. Pick folders, Continue.
- [ ] **8. Choice persists.** Settings ▸ Files & Notes → the knowledge
      base + new-note folders match what you chose in onboarding.
- [ ] **9. Import case.** Onboard with a folder that already has
      subfolders (e.g. `notes/`, `clippings/`) → those appear as options
      in the roles dropdowns.

---

**Pass criteria:** every box checks. The signal to watch is step 4 — if
organize still routes to `wiki/` after re-pointing the setting, the
indirection is broken (the injected instruction isn't being followed, or
a hard-coded path survived). Everything else confirms no behavioral
regression from the folder → setting move.
