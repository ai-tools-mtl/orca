import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export type RoutingEntrySubAction = {
  subActionId: string
  text: string
  state: 'registered' | 'delivered' | 'processed' | 'violated' | 'pending_verification'
  claimedBy?: string
  lastOutcome?: 'delivered' | 'refused' | 'unverified'
  refusalKind?: string
  firstActionSummary?: string
}

export type RoutingEntryInput = {
  inputId: string
  text: string
  decisionStatus: 'received' | 'decided'
  subActions: RoutingEntrySubAction[]
}

export type RoutingEntryCardProps = {
  paused?: boolean
  inputs: RoutingEntryInput[]
  busy?: boolean
  onRefresh?: () => void
  onClaim?: (subActionId: string, dispatchId: string) => void
  onSendSupplement?: (subActionId: string, text: string) => void
}

const STATE_BADGES: Record<
  RoutingEntrySubAction['state'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  registered: { label: '已收到', variant: 'secondary' },
  delivered: { label: '已投递', variant: 'outline' },
  processed: { label: '本轮已处理', variant: 'default' },
  violated: { label: '本轮未按补充执行', variant: 'destructive' },
  pending_verification: { label: '待核对', variant: 'secondary' }
}

/** 简洁入口 (plan §9 A / §10): the four-state supplement cards over the runtime's own facts.
 *  Presentational only — facts come from orchestration.routingInputsShow, actions delegate to
 *  the claim/send RPCs. Internal ids stay in the expandable details. */
export default function RoutingEntryCard({
  paused,
  inputs,
  busy,
  onRefresh,
  onClaim,
  onSendSupplement
}: RoutingEntryCardProps) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">调度入口</span>
        <div className="flex items-center gap-1">
          {paused ? <Badge variant="destructive">已暂停</Badge> : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
            刷新
          </Button>
        </div>
      </div>
      {inputs.length === 0 ? (
        <p className="text-muted-foreground text-xs">暂无记录的输入。</p>
      ) : null}
      {inputs.map((input) => (
        <div key={input.inputId} className="flex flex-col gap-1 rounded-md border p-2">
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {input.text.length > 60 ? `${input.text.slice(0, 60)}…` : input.text}
            </summary>
            <p className="mt-1 text-xs whitespace-pre-wrap">{input.text}</p>
            <p className="mt-1 text-xs text-muted-foreground" title={input.inputId}>
              输入 {input.inputId} · {input.decisionStatus === 'decided' ? '已决定' : '待路由'}
            </p>
          </details>
          {input.subActions.map((subAction) => {
            const badge = STATE_BADGES[subAction.state]
            return (
              <div key={subAction.subActionId} className="flex flex-col gap-1 border-t pt-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{subAction.text}</span>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
                {subAction.state === 'violated' && subAction.firstActionSummary ? (
                  <p className="text-xs text-destructive">{subAction.firstActionSummary}</p>
                ) : null}
                {subAction.lastOutcome === 'refused' && subAction.refusalKind ? (
                  <p className="text-xs text-muted-foreground">拒收：{subAction.refusalKind}</p>
                ) : null}
                {subAction.claimedBy ? (
                  <p className="text-xs text-muted-foreground" title={subAction.claimedBy}>
                    执行目标 {subAction.claimedBy}
                  </p>
                ) : null}
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !onSendSupplement}
                    onClick={() => onSendSupplement?.(subAction.subActionId, subAction.text)}
                  >
                    补充
                  </Button>
                  {subAction.claimedBy ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !onClaim}
                      onClick={() => onClaim?.(subAction.subActionId, subAction.claimedBy ?? '')}
                    >
                      交回
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
