import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { nativeChatContentMaxWidth } from '@/components/native-chat/appearance/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '@/components/native-chat/appearance/use-native-chat-store-appearance-style'
import {
  NATIVE_CHAT_FOLLOW_REARM_PX,
  geometryOf,
  isNearBottom
} from '@/components/native-chat/viewport/scroll/native-chat-autoscroll'
import { useAppStore } from '@/store'
import { useIntlLocale } from '@/i18n/use-translate'
import {
  entryTimelineDaysOf,
  startOfEntryDay,
  type EntryTimelineEvent
} from './entry-timeline-events'

export function useEntryTimeline(events: readonly EntryTimelineEvent[], visible: boolean) {
  const locale = useIntlLocale()
  const width = useAppStore((state) => state.settings?.dispatchEntryWidth ?? 'wide')
  const chatAppearance = useNativeChatStoreAppearanceStyle()
  const streamRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [today, setToday] = useState(() => startOfEntryDay(new Date()))
  const days = useMemo(() => entryTimelineDaysOf(events, today, locale), [events, today, locale])

  useEffect(() => {
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(
      () => setToday(startOfEntryDay(new Date())),
      midnight.getTime() - Date.now()
    )
    return () => window.clearTimeout(timer)
  }, [today])

  const hasEvents = events.length > 0
  const tail = events.at(-1)
  const tailId = tail?.id
  const tailResult = tail?.kind === 'result' ? tail.execution.result : undefined
  const tailFailure = tail?.kind === 'result' ? tail.execution.failure : undefined
  const latestResultId = events.findLast((event) => event.kind === 'result')?.id
  const updateJump = useCallback(() => {
    const stream = streamRef.current
    setShowJump(stream !== null && !isNearBottom(geometryOf(stream), NATIVE_CHAT_FOLLOW_REARM_PX))
  }, [])
  const onScroll = useCallback(() => {
    const stream = streamRef.current
    if (stream) {
      following.current = isNearBottom(geometryOf(stream), NATIVE_CHAT_FOLLOW_REARM_PX)
      updateJump()
    }
  }, [updateJump])
  const jumpToLatest = useCallback(() => {
    const stream = streamRef.current
    if (stream) {
      following.current = true
      stream.scrollTop = stream.scrollHeight
      updateJump()
    }
  }, [updateJump])

  useLayoutEffect(() => {
    if (!visible || !tailId) {
      following.current = true
    } else if (following.current) {
      jumpToLatest()
    }
  }, [visible, tailId, tailResult, tailFailure, jumpToLatest])

  useEffect(() => {
    const stream = streamRef.current
    if (!visible || !stream) {
      return
    }
    const observer = new ResizeObserver(updateJump)
    observer.observe(stream)
    if (stream.firstElementChild) {
      observer.observe(stream.firstElementChild)
    }
    return () => observer.disconnect()
  }, [visible, updateJump])

  return {
    days,
    hasEvents,
    latestResultId,
    scroll: { streamRef, showJump: hasEvents && showJump, onScroll, jumpToLatest },
    width,
    appearance: { ...chatAppearance, '--chat-content-max-width': nativeChatContentMaxWidth(width) }
  }
}
