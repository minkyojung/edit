import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useMarks } from '@/hooks/useMarks'
import { proofClient } from '@/lib/proofClient'
import type { CollabHandle, StoredMark } from '@/hooks/useCollabDoc'

const DOC_SLUG_KEY = 'writer-tauri:doc-slug'

interface Props {
  documentContext: string | null
  oauthStatus: 'authenticated' | 'unauthenticated' | 'checking'
  collabHandle: CollabHandle | null
}

const KIND_LABEL: Record<string, string> = {
  replace: '대체',
  insert: '삽입',
  delete: '삭제',
  comment: '코멘트',
  authored: 'AI 작성',
  approved: '승인됨',
  flagged: '플래그',
}

const KIND_DOT: Record<string, string> = {
  replace: 'bg-yellow-400',
  insert: 'bg-green-400',
  delete: 'bg-red-400',
  comment: 'bg-blue-400',
  authored: 'bg-purple-400',
  approved: 'bg-green-500',
  flagged: 'bg-orange-400',
}

const SUGGESTION_KINDS = new Set(['replace', 'insert', 'delete'])

export function ContextPanel({ collabHandle }: Props) {
  const marks = useMarks(collabHandle?.ydoc ?? null)
  const [loading, setLoading] = useState<string | null>(null)

  const slug = localStorage.getItem(DOC_SLUG_KEY)

  const entries = Object.entries(marks)
  const suggestions = entries.filter(([, m]) => SUGGESTION_KINDS.has(m.kind) && m.status === 'pending')
  const comments = entries.filter(([, m]) => m.kind === 'comment' && !m.resolved)
  const resolved = entries.filter(([, m]) =>
    (SUGGESTION_KINDS.has(m.kind) && m.status !== 'pending') || (m.kind === 'comment' && m.resolved)
  )

  async function accept(id: string) {
    if (!slug) return
    setLoading(id)
    try { await proofClient.acceptMark(slug, id) } catch (e) { console.error('[mark] accept failed', e) } finally { setLoading(null) }
  }

  async function reject(id: string) {
    if (!slug) return
    setLoading(id)
    try { await proofClient.rejectMark(slug, id) } catch (e) { console.error('[mark] reject failed', e) } finally { setLoading(null) }
  }

  if (!collabHandle) {
    return (
      <div className="flex h-full flex-col border-l border-border bg-background p-4">
        <p className="text-xs text-muted-foreground">연결 중…</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
      <div className="px-4 py-3">
        <p className="text-xs font-medium text-foreground">마크</p>
        <p className="text-xs text-muted-foreground">{entries.length}개</p>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-5">
          {suggestions.length > 0 && (
            <Section title="제안">
              {suggestions.map(([id, mark]) => (
                <SuggestionCard
                  key={id}
                  id={id}
                  mark={mark}
                  loading={loading === id}
                  onAccept={() => accept(id)}
                  onReject={() => reject(id)}
                />
              ))}
            </Section>
          )}

          {comments.length > 0 && (
            <Section title="코멘트">
              {comments.map(([id, mark]) => (
                <CommentCard key={id} mark={mark} />
              ))}
            </Section>
          )}

          {resolved.length > 0 && (
            <Section title="완료됨" muted>
              {resolved.map(([id, mark]) => (
                <ResolvedCard key={id} mark={mark} />
              ))}
            </Section>
          )}

          {entries.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">마크 없음</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function Section({ title, muted, children }: { title: string; muted?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className={`text-[10px] font-semibold uppercase tracking-wider px-1 ${muted ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
        {title}
      </p>
      {children}
    </div>
  )
}

function SuggestionCard({
  mark, loading, onAccept, onReject,
}: {
  id?: string
  mark: StoredMark
  loading: boolean
  onAccept: () => void
  onReject: () => void
}) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${KIND_DOT[mark.kind] ?? 'bg-muted-foreground'}`} />
        <span className="text-[11px] font-medium text-foreground">{KIND_LABEL[mark.kind] ?? mark.kind}</span>
        {mark.by && <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[80px]">{mark.by}</span>}
      </div>

      {mark.quote && (
        <p className="text-xs text-muted-foreground line-through leading-snug">"{mark.quote}"</p>
      )}
      {mark.content && (
        <p className="text-xs text-foreground leading-snug">"{mark.content}"</p>
      )}

      <div className="flex gap-1.5 pt-0.5">
        <Button
          size="sm"
          variant="default"
          className="h-6 flex-1 text-[11px]"
          disabled={loading}
          onClick={onAccept}
        >
          수락
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 flex-1 text-[11px]"
          disabled={loading}
          onClick={onReject}
        >
          거절
        </Button>
      </div>
    </div>
  )
}

function CommentCard({ mark }: { mark: StoredMark }) {
  return (
    <div className="rounded-md border border-border bg-card p-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full flex-shrink-0 bg-blue-400" />
        {mark.by && <span className="text-[10px] text-muted-foreground">{mark.by}</span>}
      </div>
      {mark.quote && (
        <p className="text-[11px] text-muted-foreground leading-snug">"{mark.quote}"</p>
      )}
      {mark.text && (
        <p className="text-xs text-foreground leading-snug">{mark.text}</p>
      )}
    </div>
  )
}

function ResolvedCard({ mark }: { mark: StoredMark }) {
  const label = mark.status === 'accepted' ? '수락됨' : mark.status === 'rejected' ? '거절됨' : '해결됨'
  return (
    <div className="rounded-md border border-border/50 bg-card/50 p-2.5 space-y-1 opacity-60">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${KIND_DOT[mark.kind] ?? 'bg-muted-foreground'}`} />
        <span className="text-[11px] text-muted-foreground">{KIND_LABEL[mark.kind] ?? mark.kind}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{label}</span>
      </div>
      {mark.quote && (
        <p className="text-[11px] text-muted-foreground leading-snug truncate">"{mark.quote}"</p>
      )}
    </div>
  )
}
