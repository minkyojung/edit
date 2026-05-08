function formatValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function KeyValueBlock({ label, value }: { label: string; value: unknown }) {
  const text = formatValue(value)
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-xs text-foreground/80">
        {text}
      </pre>
    </div>
  )
}
