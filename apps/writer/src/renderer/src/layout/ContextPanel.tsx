import React from 'react'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ui/prompt-input'

export function ContextPanel() {
  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex-1 overflow-y-auto" />
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea placeholder="Ask anything..." />
        </PromptInputBody>
        <PromptInputFooter>
          <div />
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
