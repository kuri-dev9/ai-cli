import { useTranslation } from 'react-i18next';
import { ExternalLink, LogOut, X } from 'lucide-react';

import { ComposerModelMenu, TokenUsageSummary } from '@/modules/chat';
import type { RoomParticipant, RoomPermissionMode } from '@/shared/types';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { useParticipantSession } from '@/modules/rooms/hooks/useParticipantSession';

type ParticipantSettingsPanelProps = {
  participant: RoomParticipant;
  /** Whether this participant holds the turn right now; it cannot leave mid-answer. */
  isSpeaking: boolean;
  /** Bumped whenever a timeline entry lands, so the token usage refreshes after each turn. */
  refreshKey: number;
  onChangePermission: (mode: RoomPermissionMode) => void;
  onLeave: () => void;
  onOpenSession: () => void;
  onClose: () => void;
};

const PERMISSION_MODES: RoomPermissionMode[] = ['ask', 'read', 'full'];

const PERMISSION_LABEL_KEYS: Record<RoomPermissionMode, string> = {
  ask: 'rooms.permissionAsk',
  read: 'rooms.permissionRead',
  full: 'rooms.permissionFull',
};

/**
 * The settings strip that opens under the participant chips: one participant
 * session's model and effort, its permission preset, its token usage, and
 * removing it from the room.
 */
export default function ParticipantSettingsPanel({
  participant,
  isSpeaking,
  refreshKey,
  onChangePermission,
  onLeave,
  onOpenSession,
  onClose,
}: ParticipantSettingsPanelProps) {
  const { t } = useTranslation('chat');
  const session = useParticipantSession(participant.provider, participant.sessionId, refreshKey);

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

  return (
    <div
      role="region"
      aria-label={t('rooms.participantSettings', { name: participant.displayName })}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 bg-muted/20 px-3 py-2 text-xs"
    >
      <span className="font-semibold text-foreground">
        {t('rooms.participantSettings', { name: participant.displayName })}
      </span>

      <label className="inline-flex items-center gap-1.5 text-muted-foreground">
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

      <div className="inline-flex items-center gap-1.5 text-muted-foreground" role="group" aria-label={t('rooms.permissionMode')}>
        {t('rooms.permissionMode')}
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {PERMISSION_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={participant.permissionMode === mode}
              onClick={() => {
                if (participant.permissionMode !== mode) onChangePermission(mode);
              }}
              className={cn(
                'px-2 py-1 transition-colors',
                participant.permissionMode === mode
                  ? 'bg-primary/15 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t(PERMISSION_LABEL_KEYS[mode])}
            </button>
          ))}
        </div>
      </div>

      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        {t('rooms.tokens')}
        <TokenUsageSummary usage={session.tokenUsage} onClick={onOpenSession} />
      </span>

      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onOpenSession}>
          <ExternalLink className="h-3.5 w-3.5" />
          {t('rooms.openSession')}
        </Button>
        {!participant.isHost && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
            disabled={Boolean(leaveBlockedReason)}
            title={leaveBlockedReason ?? undefined}
            onClick={() => {
              if (window.confirm(t('rooms.leaveConfirm', { name: participant.displayName }))) onLeave();
            }}
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('rooms.leave')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onClose}
          aria-label={t('rooms.closeSettings')}
          title={t('rooms.closeSettings')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
