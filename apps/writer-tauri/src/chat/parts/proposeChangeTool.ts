// Tool registered as `edit_document` on the `writer-relay` MCP server in
// sidecar/src/server.mjs. The Agent SDK exposes MCP tools to the model — and
// reports them back in stream events — under the `mcp__<server>__<tool>`
// canonical id, so that's the value we match on for UI routing.
//
// Phase 3.C renamed the tool from `propose_change` to `edit_document`
// (mark-based suggestions → direct in-place edits). The file name is
// kept for git-blame continuity; the exported symbol is what callers
// actually use.
export const EDIT_DOCUMENT_TOOL = 'mcp__writer-relay__edit_document'
