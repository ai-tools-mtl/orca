import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryManualPlan({
  original,
  busy,
  onSave
}: {
  original: string
  busy: boolean
  onSave: (actions: string[]) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (draft === null) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy}
        onClick={() => setDraft(original)}
      >
        {t(`${ENTRY}.manualPlan`, 'Split manually')}
      </Button>
    )
  }

  const actions = draft
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const disabled = busy || actions.length === 0 || actions.length > 6
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-card p-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) {
          setError(null)
          void onSave(actions).then(
            () => setDraft(null),
            (cause: unknown) => setError(String(cause))
          )
        }
      }}
    >
      <label className="flex flex-col gap-2 text-xs">
        {t(`${ENTRY}.manualPlanHint`, 'Enter up to six independent tasks, one per line.')}
        <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={disabled}>
          {t(`${ENTRY}.savePlan`, 'Save tasks')}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setError(null)
            setDraft(null)
          }}
        >
          {t('common.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}
