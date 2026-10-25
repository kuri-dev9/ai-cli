import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { BookmarkPlus, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useRoomRolePresets } from '@/modules/rooms/hooks/useRoomRolePresets';
import RoomPresetManager from '@/modules/rooms/RoomPresetManager';
import {
  addRoomRolePreset,
  isValidRoomDisplayName,
  pickAvailableDisplayName,
} from '@/modules/rooms/utils/roomRolePresets';
import type { RoomRolePreset } from '@/modules/rooms/utils/roomRolePresets';
import { api, readApiJson } from '@/shared/api';
import { ROOM_INVITABLE_PROVIDERS } from '@/shared/constants';
import { useEnabledProviders } from '@/shared/hooks/useEnabledProviders';
import type { ProviderModelsDefinition, RoomDetail } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** Where the invitee goes: a plain session becoming a room, or an existing room. */
type InviteTarget =
  | { kind: 'create'; hostSessionId: string }
  | { kind: 'add'; roomId: string };

type InviteParticipantModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: InviteTarget;
  /** Display names already used in the room, rejected before the request goes out. */
  takenNames: string[];
  onInvited: (detail: RoomDetail) => void;
};

/** 처음 룸을 만들 때 호스트에 미리 골라 두는 프리셋. 목록에서 지웠으면 아무것도 고르지 않는다. */
const DEFAULT_HOST_PRESET_ID = 'default-architect';

const FIELD_CLASS = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none';

/**
 * Invite form shared by InviteParticipantButton (first invite, which creates
 * the room) and RoomInterface (adding a member to an existing room).
 */
export default function InviteParticipantModal({
  open,
  onOpenChange,
  target,
  takenNames,
  onInvited,
}: InviteParticipantModalProps) {
  const { t } = useTranslation('chat');
  const enabledProviders = useEnabledProviders();
  const providers = useMemo(
    () => ROOM_INVITABLE_PROVIDERS.filter((provider) => enabledProviders.includes(provider)),
    [enabledProviders],
  );

  // Form fields: the invitee's identity as the user types it.
  const [provider, setProvider] = useState<string>(providers[0] ?? 'claude');
  const [model, setModel] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleName, setRoleName] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  // Optional host identity, only sent with the first invite.
  const [hostDisplayName, setHostDisplayName] = useState('');
  const [hostRoleName, setHostRoleName] = useState('');
  const [hostRolePrompt, setHostRolePrompt] = useState('');
  // 초대 폼과 프리셋 관리 화면 중 무엇을 보여줄지.
  const [view, setView] = useState<'invite' | 'presets'>('invite');
  // 마지막으로 고른 프리셋. 칩을 강조하는 데만 쓴다.
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [hostPresetId, setHostPresetId] = useState<string>('');
  // "프리셋으로 저장"을 누른 직후 잠깐 보여주는 확인 표시.
  const [presetSaved, setPresetSaved] = useState(false);
  const presets = useRoomRolePresets();
  // Model lists fetched so far, by provider; the select reads the chosen one.
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ProviderModelsDefinition>>({});
  // In-flight flag so a double click cannot invite twice.
  const [submitting, setSubmitting] = useState(false);
  // Server (or validation) message shown above the buttons.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modelCatalog = modelCatalogs[provider] ?? null;
  const hasModelCatalog = Boolean(modelCatalog);

  useEffect(() => {
    if (!open || hasModelCatalog) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.providers.models(provider);
        const body = await readApiJson<{ data?: { models?: ProviderModelsDefinition } }>(response);
        const models = body.data?.models;
        if (!cancelled && models) {
          setModelCatalogs((previous) => ({ ...previous, [provider]: models }));
        }
      } catch {
        // The default model still works without the list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, provider, hasModelCatalog]);

  const applyHostPreset = (presetId: string) => {
    setHostPresetId(presetId);
    const preset = presets.find((candidate) => candidate.id === presetId);
    setHostDisplayName(preset?.displayName ?? '');
    setHostRoleName(preset?.roleName ?? '');
    setHostRolePrompt(preset?.rolePrompt ?? '');
  };

  // 처음 룸을 만들 때는 호스트를 설계자로 미리 채워 둔다. 창을 열 때 한 번만.
  useEffect(() => {
    if (!open || target.kind !== 'create') return;
    if (presets.some((preset) => preset.id === DEFAULT_HOST_PRESET_ID)) {
      applyHostPreset(DEFAULT_HOST_PRESET_ID);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.kind]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setErrorMessage(null);
      setView('invite');
      setSelectedPresetId(null);
    }
    onOpenChange(next);
  };

  const selectProvider = (next: string) => {
    setProvider(next);
    // Model ids are provider-specific.
    setModel('');
  };

  // 처음 만들 때는 아직 룸이 없으니, 호스트가 쓸 이름도 겹치면 안 되는 이름이다.
  const allTakenNames = target.kind === 'create'
    ? [...takenNames, hostDisplayName.trim() || 'Claude']
    : takenNames;

  const applyPreset = (preset: RoomRolePreset) => {
    setSelectedPresetId(preset.id);
    setDisplayName(pickAvailableDisplayName(preset.displayName, allTakenNames));
    setRoleName(preset.roleName);
    setRolePrompt(preset.rolePrompt);
    // 추천 프로바이더는 쓸 수 있을 때만 따른다. 없으면 지금 고른 것을 둔다.
    if (preset.provider && providers.includes(preset.provider)) {
      selectProvider(preset.provider);
    }
  };

  const saveCurrentAsPreset = () => {
    const saved = addRoomRolePreset({
      displayName: displayName.trim(),
      roleName: roleName.trim(),
      rolePrompt: rolePrompt.trim(),
      provider: provider === 'claude' || provider === 'codex' ? provider : null,
    });
    if (saved) {
      setSelectedPresetId(saved.id);
      setPresetSaved(true);
      window.setTimeout(() => setPresetSaved(false), 1500);
    }
  };

  const trimmedName = displayName.trim();
  const nameInvalid = trimmedName.length > 0 && !isValidRoomDisplayName(trimmedName);
  const nameTaken = allTakenNames.some((name) => name.toLowerCase() === trimmedName.toLowerCase());
  const canSubmit = !submitting && isValidRoomDisplayName(trimmedName) && !nameTaken && roleName.trim().length > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage(null);
    const participant = {
      provider,
      model: model || null,
      displayName: trimmedName,
      roleName: roleName.trim(),
      rolePrompt: rolePrompt.trim() || undefined,
    };
    try {
      const response = target.kind === 'create'
        ? await api.rooms.create({
          hostSessionId: target.hostSessionId,
          host: hostDisplayName.trim() || hostRoleName.trim() || hostRolePrompt.trim()
            ? {
              displayName: hostDisplayName.trim() || undefined,
              roleName: hostRoleName.trim() || undefined,
              rolePrompt: hostRolePrompt.trim() || undefined,
            }
            : undefined,
          participant,
        })
        : await api.rooms.addParticipant(target.roomId, participant);
      const body = await readApiJson<{ data?: RoomDetail }>(response);
      if (body.data) {
        onInvited(body.data);
      }
      setDisplayName('');
      setRoleName('');
      setRolePrompt('');
      setSelectedPresetId(null);
      handleOpenChange(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-5">
        <DialogTitle>{t('rooms.inviteTitle')}</DialogTitle>
        {view === 'presets' ? (
          <RoomPresetManager onBack={() => setView('invite')} />
        ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">{t('rooms.inviteTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {target.kind === 'create' ? t('rooms.inviteDescriptionCreate') : t('rooms.inviteDescriptionAdd')}
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{t('rooms.presets')}</span>
              <button
                type="button"
                onClick={() => setView('presets')}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" />
                {t('rooms.presetsManage')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {presets.length === 0 && (
                <span className="text-xs text-muted-foreground">{t('rooms.presetsEmpty')}</span>
              )}
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  title={preset.rolePrompt || preset.roleName}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                    selectedPresetId === preset.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
                  )}
                >
                  {preset.provider && <LLMProviderLogo provider={preset.provider} className="h-3 w-3" />}
                  <span className="font-medium">{preset.displayName}</span>
                  <span className="text-muted-foreground">{preset.roleName}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.provider')}</span>
            <div className="flex gap-2">
              {ROOM_INVITABLE_PROVIDERS.map((option) => {
                const available = providers.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={!available}
                    onClick={() => selectProvider(option)}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-40',
                      provider === option ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
                    )}
                  >
                    <LLMProviderLogo provider={option} className="h-4 w-4" />
                    {option === 'codex' ? 'Codex' : 'Claude'}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.model')}</span>
            <select value={model} onChange={(event) => setModel(event.target.value)} className={FIELD_CLASS}>
              <option value="">{t('rooms.modelDefault')}</option>
              {(modelCatalog?.OPTIONS ?? []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.displayName')}</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('rooms.displayNamePlaceholder')}
                className={FIELD_CLASS}
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.roleName')}</span>
              <input
                value={roleName}
                onChange={(event) => setRoleName(event.target.value)}
                placeholder={t('rooms.roleNamePlaceholder')}
                className={FIELD_CLASS}
                autoComplete="off"
              />
            </label>
          </div>
          {(nameInvalid || nameTaken) && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {nameInvalid ? t('rooms.displayNameInvalid') : t('rooms.displayNameTaken')}
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.rolePrompt')}</span>
            <textarea
              value={rolePrompt}
              onChange={(event) => setRolePrompt(event.target.value)}
              placeholder={t('rooms.rolePromptPlaceholder')}
              rows={3}
              className={FIELD_CLASS}
            />
          </label>
          <div className="-mt-1 flex justify-end">
            <button
              type="button"
              onClick={saveCurrentAsPreset}
              disabled={!isValidRoomDisplayName(trimmedName) || !roleName.trim()}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              {presetSaved ? t('rooms.presetSaved') : t('rooms.presetSaveCurrent')}
            </button>
          </div>

          {target.kind === 'create' && (
            <details open className="rounded-md border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('rooms.hostSection')}</summary>
              <select
                value={hostPresetId}
                onChange={(event) => applyHostPreset(event.target.value)}
                aria-label={t('rooms.hostPreset')}
                className={cn(FIELD_CLASS, 'mt-2')}
              >
                <option value="">{t('rooms.hostPresetNone')}</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.displayName} · {preset.roleName}</option>
                ))}
              </select>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  value={hostDisplayName}
                  onChange={(event) => setHostDisplayName(event.target.value)}
                  placeholder={t('rooms.hostDisplayName')}
                  aria-label={t('rooms.hostDisplayName')}
                  className={FIELD_CLASS}
                  autoComplete="off"
                />
                <input
                  value={hostRoleName}
                  onChange={(event) => setHostRoleName(event.target.value)}
                  placeholder={t('rooms.hostRoleName')}
                  aria-label={t('rooms.hostRoleName')}
                  className={FIELD_CLASS}
                  autoComplete="off"
                />
              </div>
            </details>
          )}

          {errorMessage && (
            <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {errorMessage}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              {t('rooms.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting ? t('rooms.inviting') : t('rooms.invite')}
            </Button>
          </div>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
