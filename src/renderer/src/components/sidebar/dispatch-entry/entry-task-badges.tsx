import { GitBranch, Lock, Pause } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryTaskBadges({
  worktreeName,
  readOnly,
  queued
}: {
  worktreeName?: string
  readOnly?: boolean | null
  queued: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const badges = [
    {
      key: 'read-only',
      Icon: Lock,
      label: readOnly && t(`${ENTRY}.readonlyBadge`, 'Read-only investigation')
    },
    {
      key: 'queued',
      Icon: Pause,
      label: queued && t(`${ENTRY}.queuedBadge`, 'Queued on the shared folder')
    },
    { key: 'worktree', Icon: GitBranch, label: worktreeName }
  ].filter((badge) => badge.label)

  if (badges.length === 0) {
    return null
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {badges.map(({ key, Icon, label }) => (
        <Badge
          key={key}
          variant="secondary"
          className="max-w-full text-2xs font-normal whitespace-normal text-muted-foreground"
        >
          <Icon aria-hidden="true" className="size-2.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        </Badge>
      ))}
    </div>
  )
}
