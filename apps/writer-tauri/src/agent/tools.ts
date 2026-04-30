// Anthropic tool definitions for the agent.
//
// Currently a single tool — propose_change — matching the shape proof-sdk
// uses for its sub-agent bridge. The MVP runs Claude with this tool only;
// search / read_document / get_marks are added in M8.4 alongside the
// multi-turn loop.

export const proposeChangeTool = {
  name: 'propose_change',
  description: 'Propose a single suggestion or comment for the current document. Call this once per issue you find.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: {
        type: 'string',
        enum: ['suggestion', 'comment'],
        description: 'Type of change to propose.',
      },
      suggestionType: {
        type: 'string',
        enum: ['insert', 'delete', 'replace'],
        description: 'For suggestions only: insert, delete, or replace.',
      },
      quote: {
        type: 'string',
        description: 'Exact text from the document to anchor the proposal. Must match character-for-character.',
      },
      content: {
        type: 'string',
        description: 'Replacement or inserted text. Required for "insert" and "replace" suggestions.',
      },
      text: {
        type: 'string',
        description: 'Comment body. Required for comment proposals.',
      },
      rationale: {
        type: 'string',
        description: 'Brief explanation of why this change is needed.',
      },
    },
    required: ['kind', 'quote'],
  },
}
