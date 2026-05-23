# Repo notes for Claude

## External docs cache

Milkdown 7.20.0 official docs are cached at `docs/vendor/milkdown/` as raw
markdown. When working on editor code (`apps/writer-tauri/src/editor/**`),
search this cache with Grep before falling back to WebFetch — the local copy
is faster, version-pinned, and supports cross-page searches.

- Entry point: `docs/vendor/milkdown/INDEX.md`
- Refresh: `node scripts/refresh-vendor-docs.mjs`
- See `docs/vendor/milkdown/README.md` for more.
