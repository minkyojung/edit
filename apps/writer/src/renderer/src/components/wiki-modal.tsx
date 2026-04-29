import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

export function WikiModal({ onClose }: { onClose: () => void }): React.ReactElement {
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.wiki.read()
      .then((md) => {
        setMarkdown(md)
        setLoading(false)
      })
      .catch(() => {
        setError('위키를 불러오지 못했습니다. 서버 연결을 확인해주세요.')
        setLoading(false)
      })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await window.wiki.save(markdown)
      onClose()
    } catch {
      setError('저장에 실패했습니다. 서버 연결을 확인해주세요.')
    } finally {
      setSaving(false)
    }
  }, [markdown, onClose])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave]
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent onKeyDown={handleKeyDown} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>글쓰기 스타일 위키</DialogTitle>
          <DialogDescription>
            ⌘S로 저장 · 저장 시 에이전트 세션이 갱신됩니다
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center text-sm text-muted-foreground py-16">
            불러오는 중...
          </div>
        ) : error && !markdown ? (
          <div className="flex items-center justify-center text-sm text-destructive py-16">
            {error}
          </div>
        ) : (
          <Textarea
            className="font-mono text-sm leading-relaxed min-h-[320px] resize-none rounded-xl"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            autoFocus
            spellCheck={false}
          />
        )}
        <DialogFooter>
          {error && markdown && (
            <span className="text-destructive text-xs mr-auto self-center">{error}</span>
          )}
          <Button
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? '저장 중...' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
