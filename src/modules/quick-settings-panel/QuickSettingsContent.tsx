import {
  Brain,
  Eye,
  Languages,
  Mic,
  Moon,
  Send,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DarkModeToggle } from '@/shared/ui';
import { LanguageSelector } from '@/modules/i18n';
import { SETTING_ROW_CLASS } from '@/shared/constants';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '@/shared/types';
import QuickSettingsSection from '@/modules/quick-settings-panel/QuickSettingsSection';
import QuickSettingsToggleRow from '@/modules/quick-settings-panel/QuickSettingsToggleRow';
import type { TelegramSessionNotificationsState } from '@/modules/quick-settings-panel/hooks/useTelegramSessionNotifications';

/** Declarative description of one quick settings toggle row - its preference key, translation key and icon - so the rows can be rendered from a list instead of hand-written. */
type PreferenceToggleItem = {
  key: PreferenceToggleKey;
  labelKey: string;
  icon: LucideIcon;
};

const TOOL_DISPLAY_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'showRawParameters',
    labelKey: 'quickSettings.showRawParameters',
    icon: Eye,
  },
  {
    key: 'showThinking',
    labelKey: 'quickSettings.showThinking',
    icon: Brain,
  },
];

const INPUT_SETTING_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'sendByCtrlEnter',
    labelKey: 'quickSettings.sendByCtrlEnter',
    icon: Languages,
  },
  {
    key: 'voiceEnabled',
    labelKey: 'quickSettings.voiceEnabled',
    icon: Mic,
  },
];

type QuickSettingsContentProps = {
  isDarkMode: boolean;
  preferences: QuickSettingsPreferences;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
  /** 지금 열려 있는 세션. 없으면 텔레그램 알림 토글은 잠긴다. */
  activeSessionId: string | null;
  telegramNotifications: TelegramSessionNotificationsState;
};

/**
 * 텔레그램 알림 토글을 왜 못 켜는지.
 *
 * `null` 이면 켤 수 있다는 뜻이다. 잠긴 토글만 두고 이유를 말하지 않으면
 * 사용자는 알림이 고장 났다고 생각한다.
 */
function readTelegramBlockReason(
  activeSessionId: string | null,
  telegram: TelegramSessionNotificationsState,
): string | null {
  if (!activeSessionId) {
    return 'quickSettings.telegramRelay.needsSession';
  }
  if (telegram.isLoading) {
    return 'quickSettings.telegramRelay.loading';
  }
  if (!telegram.hasToken) {
    return 'quickSettings.telegramRelay.needsToken';
  }
  if (!telegram.bridgeEnabled) {
    return 'quickSettings.telegramRelay.bridgeDisabled';
  }
  if (!telegram.available) {
    return 'quickSettings.telegramRelay.bridgeStopped';
  }
  return null;
}

/** Rendered by QuickSettingsPanelView to show the drawer's appearance, tool display and input preference rows. */
export default function QuickSettingsContent({
  isDarkMode,
  preferences,
  onPreferenceChange,
  activeSessionId,
  telegramNotifications,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');
  const telegramBlockReason = readTelegramBlockReason(activeSessionId, telegramNotifications);
  const inputSettingToggles = preferences.voiceEnabled
    ? INPUT_SETTING_TOGGLES
    : INPUT_SETTING_TOGGLES.filter(({ key }) => key !== 'voiceEnabled');

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => (
      <QuickSettingsToggleRow
        key={key}
        label={t(labelKey)}
        icon={icon}
        checked={preferences[key]}
        onCheckedChange={(value) => onPreferenceChange(key, value)}
      />
    ))
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        <div className={SETTING_ROW_CLASS}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            {isDarkMode ? (
              <Moon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Sun className="h-4 w-4 text-muted-foreground" />
            )}
            {t('quickSettings.darkMode')}
          </span>
          <DarkModeToggle />
        </div>
        <LanguageSelector compact />
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        {renderToggleRows(inputSettingToggles)}
        <p className="ml-3 text-xs text-muted-foreground">
          {t('quickSettings.sendByCtrlEnterDescription')}
        </p>
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.telegramRelay')}>
        <QuickSettingsToggleRow
          label={t('quickSettings.telegramRelay.label')}
          icon={Send}
          checked={telegramNotifications.enabled}
          disabled={telegramBlockReason !== null}
          onCheckedChange={telegramNotifications.setEnabled}
        />
        <p className="ml-3 text-xs text-muted-foreground">
          {telegramBlockReason
            ? t(telegramBlockReason)
            : t('quickSettings.telegramRelay.description')}
        </p>
      </QuickSettingsSection>
    </div>
  );
}
