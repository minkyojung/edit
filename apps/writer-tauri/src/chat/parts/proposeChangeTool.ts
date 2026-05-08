// Tool registered as `propose_change` on the `writer-relay` MCP server in
// sidecar/src/server.mjs. The Agent SDK exposes MCP tools to the model — and
// reports them back in stream events — under the `mcp__<server>__<tool>`
// canonical id, so that's the value we match on for UI routing.
export const PROPOSE_CHANGE_TOOL = 'mcp__writer-relay__propose_change'
