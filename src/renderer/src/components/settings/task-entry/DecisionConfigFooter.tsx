import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { DecisionConfigTest } from './use-decision-config-test'

export function DecisionConfigFooter({
  dirty,
  defaultConfig,
  saving,
  saveDisabled,
  saveFailed,
  validation,
  onSave,
  test,
  testLabel,
  testDisabled,
  onTest
}: {
  dirty: boolean
  defaultConfig: boolean
  saving: boolean
  saveDisabled: boolean
  saveFailed: boolean
  validation?: string
  onSave: () => void
  test: DecisionConfigTest
  testLabel: string
  testDisabled: boolean
  onTest?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const tested = test.currentResult
  const draftLabel = t('auto.components.settings.TaskEntryPane.decisionModel.draftVersion', 'Draft')
  const defaultLabel = t(
    'auto.components.settings.TaskEntryPane.decisionModel.defaultConfig',
    'Default configuration'
  )
  const savedLabel = defaultConfig
    ? defaultLabel
    : t('auto.components.settings.TaskEntryPane.decisionModel.savedVersion', 'Saved version')
  const passed = t('auto.components.settings.TaskEntryPane.decisionModel.testPassed', 'Test passed')
  const failed = t('auto.components.settings.TaskEntryPane.decisionModel.testFailed', 'Test failed')
  const version = dirty ? draftLabel : savedLabel
  const testingVersion =
    test.testingVersion === 'saved'
      ? savedLabel
      : test.testingVersion === 'draft'
        ? draftLabel
        : t(
            'auto.components.settings.TaskEntryPane.decisionModel.previousVersion',
            'Earlier version'
          )

  return (
    <div data-settings-row="" className="flex flex-col gap-2 py-3">
      {validation ? <p className="text-xs text-destructive">{validation}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!dirty || saveDisabled} onClick={onSave}>
          {saving
            ? t('auto.components.settings.TaskEntryPane.decisionModel.savingConfig', 'Saving…')
            : t('auto.components.settings.TaskEntryPane.decisionModel.save', 'Save')}
        </Button>
        {onTest ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testDisabled || test.isTesting}
            onClick={onTest}
          >
            {test.isTesting
              ? t('auto.components.settings.TaskEntryPane.decisionModel.testing', 'Testing…')
              : testLabel}
          </Button>
        ) : null}
        <span role="status" className="text-xs text-muted-foreground">
          {dirty
            ? t('auto.components.settings.TaskEntryPane.decisionModel.unsaved', 'Unsaved changes')
            : defaultConfig
              ? defaultLabel
              : t('auto.components.settings.TaskEntryPane.decisionModel.configSaved', 'Saved')}
        </span>
      </div>
      {saveFailed ? (
        <p role="alert" className="text-xs text-destructive">
          {t(
            'auto.components.settings.TaskEntryPane.decisionModel.configSaveFailed',
            'Save failed. The previous configuration is still in use. Try saving again.'
          )}
        </p>
      ) : null}
      {onTest || test.isTesting || tested ? (
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p
            className={
              test.isTesting
                ? undefined
                : tested?.ok === true
                  ? 'text-status-success'
                  : tested
                    ? 'text-destructive'
                    : undefined
            }
          >
            {test.isTesting
              ? t(
                  'auto.components.settings.TaskEntryPane.decisionModel.testInProgress',
                  'Testing {{version}} on {{host}}…',
                  {
                    version: testingVersion,
                    host: test.testingHost ?? test.hostLabel
                  }
                )
              : t(
                  'auto.components.settings.TaskEntryPane.decisionModel.testVersionOnHost',
                  '{{version}} · {{host}} · {{status}}',
                  {
                    version,
                    host: test.hostLabel,
                    status: tested
                      ? tested.ok
                        ? passed
                        : failed
                      : t(
                          'auto.components.settings.TaskEntryPane.decisionModel.notTested',
                          'Not tested'
                        )
                  }
                )}
            {!test.isTesting && tested?.agent ? ` · ${tested.agent}` : null}
          </p>
          {!test.isTesting && tested?.ok === false && tested.detail ? (
            <p className="break-words text-destructive">{tested.detail}</p>
          ) : null}
        </div>
      ) : null}
      {dirty && test.savedResult ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.TaskEntryPane.decisionModel.testVersionOnHost',
            '{{version}} · {{host}} · {{status}}',
            {
              version: savedLabel,
              host: test.hostLabel,
              status: test.savedResult.ok ? passed : failed
            }
          )}
        </p>
      ) : null}
    </div>
  )
}
