import { useTranslation } from 'react-i18next';

import { DarkModeToggle } from '@/shared/ui';
import type { CodeEditorSettingsState, ProjectSortOrder } from '@/shared/types';
import type { FontFamilyId, FontScaleId, HeadingFontId } from '@/shared/fontSettings';
import {
  FONT_FAMILIES,
  FONT_FAMILY_IDS,
  FONT_SCALE_IDS,
  HEADING_FONT_IDS,
} from '@/shared/fontSettings';
import { useFontSettings } from '@/shared/hooks/useFontSettings';
import { LanguageSelector } from '@/modules/i18n';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

/** Rendered by Settings for the "appearance" tab, covering theme, project sorting and code editor preferences. */
export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [fontSettings, updateFontSettings] = useFontSettings();

  // 글꼴 이름은 고유명사라 번역하지 않는다. 번역이 필요한 건 "시스템 기본" 처럼
  // 특정 글꼴을 가리키지 않는 항목뿐이다.
  const familyLabel = (id: FontFamilyId) => (
    id === 'system' ? t('appearanceSettings.fonts.systemDefault') : FONT_FAMILIES[id].label
  );

  const headingLabel = (id: HeadingFontId) => (
    id === 'sameAsBody' ? t('appearanceSettings.fonts.sameAsBody') : familyLabel(id)
  );

  const selectClassName =
    'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-44';

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.darkMode.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.darkMode.label')}
            description={t('appearanceSettings.darkMode.description')}
          >
            <DarkModeToggle ariaLabel={t('appearanceSettings.darkMode.label')} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('appearanceSettings.fonts.title')}
        description={t('appearanceSettings.fonts.offlineHint')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.fonts.body.label')}
            description={t('appearanceSettings.fonts.body.description')}
          >
            <select
              value={fontSettings.body}
              onChange={(event) => updateFontSettings({ body: event.target.value as FontFamilyId })}
              className={selectClassName}
              aria-label={t('appearanceSettings.fonts.body.label')}
            >
              {FONT_FAMILY_IDS.map((id) => (
                <option key={id} value={id} style={{ fontFamily: FONT_FAMILIES[id].stack }}>
                  {familyLabel(id)}
                </option>
              ))}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.fonts.heading.label')}
            description={t('appearanceSettings.fonts.heading.description')}
          >
            <select
              value={fontSettings.heading}
              onChange={(event) => updateFontSettings({ heading: event.target.value as HeadingFontId })}
              className={selectClassName}
              aria-label={t('appearanceSettings.fonts.heading.label')}
            >
              {HEADING_FONT_IDS.map((id) => (
                <option
                  key={id}
                  value={id}
                  style={id === 'sameAsBody' ? undefined : { fontFamily: FONT_FAMILIES[id].stack }}
                >
                  {headingLabel(id)}
                </option>
              ))}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.fonts.scale.label')}
            description={t('appearanceSettings.fonts.scale.description')}
          >
            <select
              value={fontSettings.scale}
              onChange={(event) => updateFontSettings({ scale: event.target.value as FontScaleId })}
              className={selectClassName}
              aria-label={t('appearanceSettings.fonts.scale.label')}
            >
              {FONT_SCALE_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`appearanceSettings.fonts.scaleOptions.${id}`)}
                </option>
              ))}
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
