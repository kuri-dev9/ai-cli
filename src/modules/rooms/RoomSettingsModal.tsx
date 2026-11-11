import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Settings2, X } from 'lucide-react';

import { AutoCompactFields } from '@/modules/chat';
import { api } from '@/shared/api';
import type { RoomDetail, RoomPermissionMode } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Input, Slider } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { ROOM_PERMISSION_LABEL_KEYS, ROOM_PERMISSION_MODES } from '@/modules/rooms/utils/roomPermissions';

/** 서버 상한과 같다. */
const MAX_AUTO_TURNS_LIMIT = 100;

type RoomSettingsChanges = {
  maxAutoTurns?: number;
  splitWork?: boolean;
  discussion?: boolean;
  hostLed?: boolean;
  autoCompact?: boolean;
  autoCompactEveryTurns?: number;
  autoCompactTokens?: number;
  notifyTelegram?: boolean;
  permissionMode?: RoomPermissionMode;
};

type RoomSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: RoomDetail['room'];
  /** 룸의 이름은 원래 대화(호스트 세션)의 이름이다. */
  roomName: string;
  onUpdateSettings: (changes: RoomSettingsChanges) => Promise<void>;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ label, hint, on, onToggle }: { label: string; hint: string; on: boolean; onToggle: () => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={cn(
          'relative mt-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-all', on ? 'left-[1.125rem]' : 'left-0.5')} />
      </button>
    </label>
  );
}

/**
 * 룸의 설정을 한곳에서 고친다 — 이름, 협업 방식, 권한, 자동 턴 수, 자동 대화
 * 줄이기. 머리말의 단추들과 같은 값을 고치므로 어느 쪽에서 바꿔도 서로 따라간다.
 */
export default function RoomSettingsModal({ open, onOpenChange, room, roomName, onUpdateSettings }: RoomSettingsModalProps) {
  const { t } = useTranslation('chat');
  const [name, setName] = useState(roomName);
  const [nameState, setNameState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(roomName);
    setNameState('idle');
    setError(null);
    // roomName 은 열 때의 값만 쓴다. 고치는 중에 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = async (changes: RoomSettingsChanges) => {
    setError(null);
    try {
      await onUpdateSettings(changes);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    }
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === roomName.trim()) return;
    setNameState('saving');
    setError(null);
    try {
      const response = await api.renameSession(room.hostSessionId, trimmed);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNameState('saved');
    } catch (saveError) {
      setNameState('idle');
      setError(t('sessionSettings.renameFailed', { reason: saveError instanceof Error ? saveError.message : String(saveError) }));
    }
  };

  const toggles = [
    { key: 'splitWork', label: t('rooms.splitWork'), hint: t('rooms.splitWorkTitle'), on: room.splitWork },
    { key: 'discussion', label: t('rooms.discussion'), hint: t('rooms.discussionTitle'), on: room.discussion },
    { key: 'hostLed', label: t('rooms.hostLed'), hint: t('rooms.hostLedTitle'), on: room.hostLed },
    { key: 'notifyTelegram', label: t('rooms.notifyTelegram'), hint: t('rooms.notifyTelegramTitle'), on: room.notifyTelegram },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,44rem)] w-[calc(100vw-1rem)] max-w-lg flex-col overflow-hidden p-0">
        <DialogTitle>{t('rooms.settingsTitle')}</DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Settings2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-semibold">{t('rooms.settingsTitle')}</span>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t('sessionSettings.close')}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error && (
            <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <Section title={t('rooms.settingsName')}>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <Input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameState('idle');
                }}
                placeholder={t('sessionSettings.namePlaceholder')}
                aria-label={t('rooms.settingsName')}
              />
              <Button
                type="submit"
                size="sm"
                className="h-9 flex-shrink-0"
                disabled={nameState === 'saving' || !name.trim() || name.trim() === roomName.trim()}
              >
                {nameState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : nameState === 'saved' ? t('sessionSettings.saved') : t('sessionSettings.save')}
              </Button>
            </form>
            <p className="truncate text-xs text-muted-foreground" title={room.projectPath}>{room.projectPath}</p>
          </Section>

          <Section title={t('rooms.collaboration')}>
            {toggles.map((toggle) => (
              <Toggle
                key={toggle.key}
                label={toggle.label}
                hint={toggle.hint}
                on={toggle.on}
                onToggle={() => void update({ [toggle.key]: !toggle.on })}
              />
            ))}
          </Section>

          <Section title={t('rooms.permissionModeAll')}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('rooms.permissionModeAll')}>
              {ROOM_PERMISSION_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={room.permissionMode === mode}
                  onClick={() => {
                    if (room.permissionMode !== mode) void update({ permissionMode: mode });
                  }}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    room.permissionMode === mode
                      ? 'border-primary/40 bg-primary/15 font-medium text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {t(ROOM_PERMISSION_LABEL_KEYS[mode])}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('rooms.permissionModeAllTitle')}</p>
          </Section>

          <Section title={t('rooms.settingsTurns')}>
            <Slider
              label={t('rooms.settingsMaxAutoTurns')}
              value={room.maxAutoTurns}
              min={1}
              max={MAX_AUTO_TURNS_LIMIT}
              formatValue={(value) => t('autoCompact.everyTurnsValue', { count: value })}
              hint={t('rooms.maxAutoTurnsTitle', { max: MAX_AUTO_TURNS_LIMIT })}
              onCommit={(value) => void update({ maxAutoTurns: value })}
            />
          </Section>

          <Section title={t('autoCompact.title')}>
            <Toggle
              label={t('rooms.autoCompact')}
              hint={t('autoCompact.roomHint')}
              on={room.autoCompact}
              onToggle={() => void update({ autoCompact: !room.autoCompact })}
            />
            <AutoCompactFields
              everyTurns={room.autoCompactEveryTurns}
              tokens={room.autoCompactTokens}
              tokensOffLabel={t('autoCompact.roomDefault')}
              disabled={!room.autoCompact}
              onChange={(changes) => void update({
                autoCompactEveryTurns: changes.everyTurns,
                autoCompactTokens: changes.tokens,
              })}
            />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
