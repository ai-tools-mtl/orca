import { MoveHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { NativeChatWidth } from '../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { getChatWidthOptions } from '../../settings/appearance/chat/chat-appearance-search'

export function EntryWidthSubmenu({ width }: { width: NativeChatWidth }): React.JSX.Element {
  const t = useTranslate()
  const label = t('settings.appearance.chat.width', 'Width')
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MoveHorizontal aria-hidden="true" />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup aria-label={label} value={width}>
          {getChatWidthOptions(t).map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onSelect={() => {
                if (option.value !== width) {
                  void useAppStore
                    .getState()
                    .updateSettingsOrThrow({ dispatchEntryWidth: option.value })
                    .catch((error: unknown) => toast.error(String(error)))
                }
              }}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
