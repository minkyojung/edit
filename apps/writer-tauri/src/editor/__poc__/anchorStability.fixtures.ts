// Editor-NEUTRAL fixtures. Each is a markdown body + an AI edit + a
// deterministic user-edit script + the expected post-edit placement.
// The SAME fixtures feed the PM control and (Phase 2) the CM prototype.
//
// `edit.id` is overwritten by the adapter; the value here is a placeholder.
// PRIMARY metric fixtures (single-anchor/drift/unplaced/block-add) carry a
// pure PM-position signal. `hunks` fixtures are the disk-derived bucket,
// reported separately.

import type { Fixture } from './anchorStability.types'

const BODY_3P = ['Alpha line one.', '', 'The quick brown fox jumps.', '', 'Gamma line three.'].join('\n')

export const fixtures: Fixture[] = [
  // ① single-line replace, user edits ABOVE the anchor (different block).
  {
    name: 'replace · edit above',
    group: 'drift',
    initialBody: BODY_3P,
    edit: { id: 'e', kind: 'replace', anchorBefore: '', before: 'quick brown', after: 'swift red' },
    userEditScript: [{ kind: 'insertText', find: 'Alpha', where: 'before', text: 'XX ' }],
    safeTokens: ['Alpha', 'Gamma'],
    expectedStatus: 'placed',
    expectedTargetText: 'quick brown',
    expectedBody: ['Alpha line one.', '', 'The swift red fox jumps.', '', 'Gamma line three.'].join('\n'),
  },

  // ② single-line replace, user edits in the SAME block, BEFORE the anchor.
  {
    name: 'replace · edit before (same block)',
    group: 'drift',
    initialBody: BODY_3P,
    edit: { id: 'e', kind: 'replace', anchorBefore: '', before: 'quick brown', after: 'swift red' },
    userEditScript: [{ kind: 'insertText', find: 'The quick', where: 'before', text: 'Note— ' }],
    safeTokens: ['Alpha', 'Gamma'],
    expectedStatus: 'placed',
    expectedTargetText: 'quick brown',
  },

  // ③ single-line replace, user edits AFTER the anchor.
  {
    name: 'replace · edit after',
    group: 'drift',
    initialBody: BODY_3P,
    edit: { id: 'e', kind: 'replace', anchorBefore: '', before: 'quick brown', after: 'swift red' },
    userEditScript: [{ kind: 'insertText', find: 'jumps', where: 'after', text: ' high' }],
    safeTokens: ['Alpha', 'Gamma', 'jumps'],
    expectedStatus: 'placed',
    expectedTargetText: 'quick brown',
  },

  // ④ delete, user edits above. Anchor covers the to-be-removed text.
  {
    name: 'delete · edit above',
    group: 'single-anchor',
    initialBody: BODY_3P,
    edit: { id: 'e', kind: 'delete', anchorBefore: '', before: 'Gamma line three' },
    userEditScript: [{ kind: 'insertText', find: 'Alpha', where: 'after', text: ' EDIT' }],
    safeTokens: ['Alpha', 'fox'],
    expectedStatus: 'placed',
    expectedTargetText: 'Gamma line three',
  },

  // ⑤ add (append to end). User inserts a block in the middle; the append
  //    point must follow to the new end. Block-add → accept materialises.
  {
    name: 'add · append, block inserted above',
    group: 'block-add',
    initialBody: BODY_3P,
    edit: { id: 'e', kind: 'add', anchorBefore: '', after: 'New appended paragraph.' },
    userEditScript: [{ kind: 'insertBlock', afterFind: 'Alpha line one', markdown: 'Inserted block.' }],
    // Only tokens NOT in the last block — the append point sits right
    // after 'Gamma line three.', so editing it would legitimately change
    // textBeforeInsert (that's not an "unrelated" edit).
    safeTokens: ['Alpha', 'fox'],
    expectedStatus: 'placed',
    expectedTextBeforeInsert: 'Gamma line three.',
    expectedBody: [
      'Alpha line one.',
      '',
      'The quick brown fox jumps.',
      '',
      'Gamma line three.',
      '',
      'New appended paragraph.',
    ].join('\n'),
  },

  // ⑥ add after a named anchor; intra-block edit keeps insertAt at block end.
  {
    name: 'add · after anchor, intra-block edit',
    group: 'single-anchor',
    initialBody: BODY_3P,
    edit: { id: 'e', kind: 'add', anchorBefore: 'The quick brown fox jumps.', after: 'Tail note.' },
    userEditScript: [{ kind: 'insertText', find: 'jumps', where: 'before', text: 'really ' }],
    safeTokens: ['Alpha', 'Gamma'],
    expectedStatus: 'placed',
    expectedTextBeforeInsert: 'jumps.',
  },

  // ⑦ duplicate anchor — documents PM's first-occurrence pinning.
  {
    name: 'replace · duplicate anchor (first match)',
    group: 'single-anchor',
    initialBody: ['The cat sat.', '', 'The cat ran.'].join('\n'),
    edit: { id: 'e', kind: 'replace', anchorBefore: '', before: 'The cat', after: 'A dog' },
    userEditScript: [{ kind: 'insertText', find: 'ran', where: 'before', text: 'quickly ' }],
    safeTokens: ['ran', 'sat'],
    expectedStatus: 'placed',
    expectedTargetText: 'The cat',
  },

  // ⑧ unplaced → promotion. The user edit CREATES the anchor text; the
  //    plugin's apply() re-resolution branch must promote it to placed.
  {
    name: 'unplaced → placed on re-resolution',
    group: 'unplaced',
    initialBody: 'Only this paragraph.',
    edit: { id: 'e', kind: 'replace', anchorBefore: '', before: 'magic words', after: 'spell' },
    userEditScript: [{ kind: 'insertText', find: 'Only this paragraph', where: 'after', text: ' magic words' }],
    expectedStatus: 'placed',
    expectedTargetText: 'magic words',
  },

  // ⑨ whole-file replace on a populated page → hunks (disk-derived bucket).
  {
    name: 'whole-file replace → hunks',
    group: 'hunks',
    initialBody: ['First paragraph here.', '', 'Second paragraph here.', '', 'Third paragraph here.'].join('\n'),
    edit: {
      id: 'e',
      kind: 'replace',
      anchorBefore: '',
      after: ['First paragraph here.', '', 'Second paragraph CHANGED.', '', 'Third paragraph here.'].join('\n'),
    },
    userEditScript: [{ kind: 'insertText', find: 'First paragraph', where: 'after', text: ' x' }],
    safeTokens: ['First', 'Third'],
    expectedStatus: 'hunks',
  },

  // ⑩ whole-file replace on an empty page → single placed insert at top.
  {
    name: 'whole-file replace on empty page',
    group: 'hunks',
    initialBody: '',
    edit: { id: 'e', kind: 'replace', anchorBefore: '', after: 'Brand new body.' },
    userEditScript: [],
    expectedStatus: 'placed',
  },
]
