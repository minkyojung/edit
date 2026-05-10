// AI proposal shape — what the model emits via the propose_change tool.
//
// Mirrors proof-sdk's ProposedSuggestion / ProposedComment so we can adopt
// the same skill prompts without rewriting them. We do NOT replicate
// proof-sdk's heavier metadata fields (candidateId, runId on the proposal
// itself, etc.) — those are layered on later when the proposal is applied
// as a Y.Map mark.

export type Proposal =
  | {
      kind: 'suggestion'
      suggestionType: 'insert' | 'delete' | 'replace'
      quote: string
      content?: string
      rationale?: string
    }
  | {
      kind: 'comment'
      quote: string
      text: string
      rationale?: string
    }
