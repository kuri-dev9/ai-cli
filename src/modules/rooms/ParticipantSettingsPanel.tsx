import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, LogOut, Minimize2, Pencil, X } from 'lucide-react';

import { ComposerModelMenu, TokenUsageSummary } from '@/modules/chat';
import type { RoomParticipant, RoomPermissionMode } from '@/shared/types';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { useParticipantSession } from '@/modules/rooms/hooks/useParticipantSession';
import { isValidRoomDisplayName } from '@/modules/rooms/utils/roomRolePresets';
import { ROOM_PERMISSION_LABEL_KEYS, ROOM_PERMISSION_MODES } from '@/modules/rooms/utils/roomPermissions';

type ParticipantSettingsPanelProps = {
  participant: RoomParticipant;
  /** Whether this participant holds the turn right now; it cannot leave mid-answer. */
  isSpeaking: boolean;
  /** Bumped whenever a timeline entry lands, so the token usage refreshes after each turn. */
  refreshKey: number;
  onChangePermission: (mode: RoomPermissionMode) => void;
  /** 이름·역할·역할 지시·성향을 고친다. 고치면 참가자가 다음 차례에 다시 안내받는다. */
  onChangeProfile: (profile: { displayName: string; roleName: string; rolePrompt: string; persona: string }) => void;
  /** 이 참가자 세션의 맥락만 줄인다. 쌓인 토큰을 되돌리는 데 쓴다. */
  onCompact: () => void;
  onLeave: () => void;
  onOpenSession: () => void;
  onClose: () => void;
};

const FIELD_CLASS = 'w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none';

/**
 * The settings card that opens beside the participant list as a submenu: one
 * participant session's model and effort, its permission preset, its token
 * usage, and removing it from the room.
 */
export default function ParticipantSettingsPanel({
  participant,
  isSpeaking,
  refreshKey,
  onChangePermission,
  onChangeProfile,
  onCompact,
  onLeave,
  onOpenSession,
  onClose,
}: ParticipantSettingsPanelProps) {
  const { t } = useTranslation('chat');
  const session = useParticipantSession(participant.provider, participant.sessionId, refreshKey);
  // 역할 편집 폼이 열려 있으면 고치는 중인 값. 닫혀 있으면 null.
  const [draft, setDraft] = useState<{ displayName: string; roleName: string; rolePrompt: string; persona: string } | null>(null);

  const selectModel = (model: string) => {
    void session.selectModel(model).catch((error: unknown) => {
      console.error('Error changing the participant model:', error);
    });
  };
  const selectEffort = (effort: string) => {
    void session.selectEffort(effort).catch((error: unknown) => {
      console.error('Error changing the participant reasoning effort:', error);
    });
  };

  // The host is the room itself, so it has no leave button at all.
  const leaveBlockedReason = isSpeaking ? t('rooms.leaveWhileSpeaking') : null;

  const openEditor = () => setDraft({
    displayName: participant.displayName,
    roleName: participant.roleName,
    rolePrompt: participant.rolePrompt,
    persona: participant.persona,
  });

  const draftNameValid = draft ? isValidRoomDisplayName(draft.displayName.trim()) : false;
  const canSaveDraft = Boolean(draft) && draftNameValid && Boolean(draft?.roleName.trim());

  return (
    <div
      role="region"
      aria-label={t('rooms.participantSettings', { name: participant.displayName })}
      className="space-y-2.5 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-semibold text-foreground">
          {t('rooms.participantSettings', { name: participant.displayName })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 flex-shrink-0 p-0"
          onClick={onClose}
          aria-label={t('rooms.closeSettings')}
          title={t('rooms.closeSettings')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <label className="flex items-center justify-between gap-2 text-muted-foreground">
        {t('rooms.model')}
        <ComposerModelMenu
          effort={session.effort}
          effortOptions={session.effortOptions}
          onSelectEffort={selectEffort}
          model={session.model}
          modelOptions={session.modelOptions}
          onSelectModel={selectModel}
          modelsLoading={session.modelsLoading}
        />
      </label>

      <div className="flex items-center justify-between gap-2 text-muted-foreground" role="group" aria-label={t('rooms.permissionMode')}>
        {t('rooms.permissionMode')}
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {ROOM_PERMISSION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={participant.permissionMode === mode}
              onClick={() => {
                if (participant.permissionMode !== mode) onChangePermission(mode);
              }}
              className={cn(
                'whitespace-nowrap px-2 py-1 transition-colors',
                participant.permissionMode === mode
                  ? 'bg-primary/15 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t(ROOM_PERMISSION_LABEL_KEYS[mode])}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        {t('rooms.tokens')}
        <TokenUsageSummary usage={session.tokenUsage} onClick={onOpenSession} />
      </div>

      <div className="grid grid-cols-2 gap-1 border-t border-border/50 pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start gap-1 px-2 text-xs"
          aria-expanded={draft !== null}
          onClick={() => (draft ? setDraft(null) : openEditor())}
        >
          <Pencil className="h-3.5 w-3.5" />
          {t('rooms.editRole')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start gap-1 px-2 text-xs"
          disabled={isSpeaking || !participant.sessionId}
          title={isSpeaking ? t('rooms.compactWhileRunning') : t('rooms.compactOneTitle')}
          onClick={onCompact}
        >
          <Minimize2 className="h-3.5 w-3.5" />
          {t('rooms.compactOne')}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 justify-start gap-1 px-2 text-xs" onClick={onOpenSession}>
          <ExternalLink className="h-3.5 w-3.5" />
          {t('rooms.openSession')}
        </Button>
        {!participant.isHost && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 justify-start gap-1 px-2 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
            disabled={Boolean(leaveBlockedReason)}
            title={leaveBlockedReason ?? undefined}
            onClick={() => {
              // 한 번도 부른 적 없는 멤버는 지울 대화가 없어 명단에서 아주 뺀다.
              // 일한 적 있는 참가자는 룸에 남고 차례만 오지 않는다.
              const confirmKey = participant.sessionId ? 'rooms.leaveConfirm' : 'rooms.leaveRosterConfirm';
              if (window.confirm(t(confirmKey, { name: participant.displayName }))) onLeave();
            }}
          >
            <LogOut className="h-3.5 w-3.5" />
            {t(participant.sessionId ? 'rooms.leave' : 'rooms.leaveRoster')}
          </Button>
        )}
      </div>

    {draft && (
      <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-2">
        <p className="text-[11px] text-muted-foreground">{t('rooms.editRoleHint')}</p>
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
        {draft.displayName.trim().length > 0 && !draftNameValid && (
          <p className="text-[11px] text-red-600 dark:text-red-400">{t('rooms.displayNameInvalid')}</p>
        )}
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
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)}>
            {t('rooms.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            disabled={!canSaveDraft}
            onClick={() => {
              onChangeProfile({
                displayName: draft.displayName.trim(),
                roleName: draft.roleName.trim(),
                rolePrompt: draft.rolePrompt.trim(),
                persona: draft.persona.trim(),
              });
              setDraft(null);
            }}
          >
            {t('rooms.presetSave')}
          </Button>
        </div>
      </div>
    )}
    </div>
  );
}
