import type { AppSettings } from './types'

type ScannerRelevantSettings = Pick<
  AppSettings,
  'scan' | 'stability' | 'rules' | 'activeRuleId' | 'connections'
>

export function shouldRestartScannerAfterSettingsSave(
  data: Partial<ScannerRelevantSettings>
): boolean {
  return (
    data.scan !== undefined ||
    data.stability !== undefined ||
    data.rules !== undefined ||
    data.activeRuleId !== undefined ||
    data.connections !== undefined
  )
}
