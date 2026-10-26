import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useRoomRolePresets } from '@/modules/rooms/hooks/useRoomRolePresets';
import {
  addRoomRolePreset,
  deleteRoomRolePreset,
  isValidRoomDisplayName,
  moveRoomRolePreset,
  resetRoomRolePresets,
  updateRoomRolePreset,
} from '@/modules/rooms/utils/roomRolePresets';
import type { RoomRolePreset } from '@/modules/rooms/utils/roomRolePresets';
import { Button, LLMProviderLogo } from '@/shared/ui';

const FIELD_CLASS = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none';
const ICON_BUTTON_CLASS = 'rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30';

type PresetDraft = Omit<RoomRolePreset, 'id'>;

const EMPTY_DRAFT: PresetDraft = { displayName: '', roleName: '', rolePrompt: '', persona: '', provider: null };

type PresetFormProps = {
  initial: PresetDraft;
  onSave: (draft: PresetDraft) => void;
  onCancel: () => void;
};

/** 프리셋 하나를 새로 만들거나 고치는 칸. */
function PresetForm({ initial, onSave, onCancel }: PresetFormProps) {
  const { t } = useTranslation('chat');
  const [draft, setDraft] = useState<PresetDraft>(initial);
  const name = draft.displayName.trim();
  const nameInvalid = name.length > 0 && !isValidRoomDisplayName(name);
  const canSave = isValidRoomDisplayName(name) && draft.roleName.trim().length > 0;

  return (
    <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
      <div className="grid grid-cols-2 gap-2">
        <input
          value={draft.displayName}
          onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          placeholder={t('rooms.displayName')}
          aria-label={t('rooms.displayName')}
          className={FIELD_CLASS}
          autoComplete="off"
        />
        <input
          value={draft.roleName}
          onChange={(event) => setDraft({ ...draft, roleName: event.target.value })}
          placeholder={t('rooms.roleName')}
          aria-label={t('rooms.roleName')}
          className={FIELD_CLASS}
          autoComplete="off"
        />
      </div>
      {nameInvalid && <p className="text-xs text-red-600 dark:text-red-400">{t('rooms.displayNameInvalid')}</p>}
      <select
        value={draft.provider ?? ''}
        onChange={(event) => setDraft({ ...draft, provider: event.target.value === 'claude' || event.target.value === 'codex' ? event.target.value : null })}
        aria-label={t('rooms.presetProvider')}
        className={FIELD_CLASS}
      >
        <option value="">{t('rooms.presetProviderAny')}</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <textarea
        value={draft.rolePrompt}
        onChange={(event) => setDraft({ ...draft, rolePrompt: event.target.value })}
        placeholder={t('rooms.rolePromptPlaceholder')}
        aria-label={t('rooms.rolePrompt')}
        rows={3}
        className={FIELD_CLASS}
      />
      <textarea
        value={draft.persona}
        onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
        placeholder={t('rooms.personaPlaceholder')}
        aria-label={t('rooms.persona')}
        rows={2}
        className={FIELD_CLASS}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>{t('rooms.cancel')}</Button>
        <Button type="button" size="sm" disabled={!canSave} onClick={() => onSave(draft)}>{t('rooms.presetSave')}</Button>
      </div>
    </div>
  );
}

type RoomPresetManagerProps = {
  onBack: () => void;
};

/**
 * 역할 프리셋을 추가·수정·삭제·정렬하는 화면. InviteParticipantModal 이 "관리"를
 * 누르면 초대 폼 자리에 이걸 띄운다.
 */
export default function RoomPresetManager({ onBack }: RoomPresetManagerProps) {
  const { t } = useTranslation('chat');
  const presets = useRoomRolePresets();
  // 지금 열려 있는 폼: 새 프리셋이거나, 고치는 프리셋의 id.
  const [editing, setEditing] = useState<'new' | string | null>(null);
  // 기본값 복원은 한 번 더 눌러야 실행된다. 직접 만든 프리셋이 한 번에 사라지는 일이라서다.
  const [confirmingReset, setConfirmingReset] = useState(false);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{t('rooms.presetsTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('rooms.presetsDescription')}</p>
      </div>

      <ul className="space-y-2">
        {presets.length === 0 && (
          <li className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {t('rooms.presetsEmpty')}
          </li>
        )}
        {presets.map((preset, index) => (
          <li key={preset.id}>
            {editing === preset.id ? (
              <PresetForm
                initial={preset}
                onCancel={() => setEditing(null)}
                onSave={(draft) => {
                  if (updateRoomRolePreset(preset.id, draft)) {
                    setEditing(null);
                  }
                }}
              />
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm">
                    {preset.provider && <LLMProviderLogo provider={preset.provider} className="h-3.5 w-3.5" />}
                    <span className="font-medium">{preset.displayName}</span>
                    <span className="text-muted-foreground">· {preset.roleName}</span>
                  </div>
                  {preset.rolePrompt && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{preset.rolePrompt}</p>
                  )}
                  {preset.persona && (
                    <p className="mt-0.5 line-clamp-1 text-xs italic text-muted-foreground/80">{preset.persona}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <button type="button" className={ICON_BUTTON_CLASS} disabled={index === 0} onClick={() => moveRoomRolePreset(preset.id, -1)} title={t('rooms.presetMoveUp')} aria-label={t('rooms.presetMoveUp')}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" className={ICON_BUTTON_CLASS} disabled={index === presets.length - 1} onClick={() => moveRoomRolePreset(preset.id, 1)} title={t('rooms.presetMoveDown')} aria-label={t('rooms.presetMoveDown')}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" className={ICON_BUTTON_CLASS} onClick={() => setEditing(preset.id)} title={t('rooms.presetEdit')} aria-label={t('rooms.presetEdit')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" className={ICON_BUTTON_CLASS} onClick={() => deleteRoomRolePreset(preset.id)} title={t('rooms.presetDelete')} aria-label={t('rooms.presetDelete')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing === 'new' ? (
        <PresetForm
          initial={EMPTY_DRAFT}
          onCancel={() => setEditing(null)}
          onSave={(draft) => {
            if (addRoomRolePreset(draft)) {
              setEditing(null);
            }
          }}
        />
      ) : (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => setEditing('new')}>
          <Plus className="mr-1 h-4 w-4" />
          {t('rooms.presetNew')}
        </Button>
      )}

      <div className="flex items-center justify-between pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!confirmingReset) {
              setConfirmingReset(true);
              return;
            }
            resetRoomRolePresets();
            setConfirmingReset(false);
            setEditing(null);
          }}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          {confirmingReset ? t('rooms.presetResetConfirm') : t('rooms.presetReset')}
        </Button>
        <Button type="button" size="sm" onClick={onBack}>{t('rooms.presetBack')}</Button>
      </div>
    </div>
  );
}
