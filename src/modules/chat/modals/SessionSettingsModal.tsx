import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Settings2, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { ChatAttachment, ChatImage, ChatMessage, LLMProvider, PermissionMode, Project } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';
import AutoCompactFields from '@/modules/chat/settings/AutoCompactFields';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';
import ChatMessageImages from '@/modules/chat/transcript/ChatMessageImages';

/** `/compact` 를 알아듣는 프로바이더. 나머지는 자동 대화 줄이기를 쓸 수 없다. */
const COMPACTABLE_PROVIDERS = new Set<LLMProvider>(['claude', 'codex']);

type SessionSettings = {
  autoCompactEveryTurns: number;
  autoCompactTokens: number;
  turnsSinceCompact: number;
};

type SessionSettingsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionName: string;
  provider: LLMProvider;
  providerLabel: string;
  model?: string | null;
  project: Project | null;
  permissionMode: PermissionMode;
  permissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  /** 다른 프로젝트로 옮길 수 있는 프로바이더인지. 실제로 옮기려면 쉬고 있어야 한다. */
  supportsMove: boolean;
  isProcessing: boolean;
  /** 지금 불러온 대화. 오간 첨부를 여기서 모은다. */
  messages: ChatMessage[];
  allMessagesLoaded: boolean;
  onLoadAllMessages?: () => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 지금 세션의 설정을 한곳에서 고친다 — 이름, 위치(프로젝트), 권한, 자동 대화
 * 줄이기, 그리고 이 대화에서 오간 첨부 목록. ChatInterface 가 연다.
 */
export default function SessionSettingsModal({
  open,
  onOpenChange,
  sessionId,
  sessionName,
  provider,
  providerLabel,
  model,
  project,
  permissionMode,
  permissionModes,
  onSelectPermissionMode,
  supportsMove,
  isProcessing,
  messages,
  allMessagesLoaded,
  onLoadAllMessages,
}: SessionSettingsModalProps) {
  const { t } = useTranslation('chat');

  const [name, setName] = useState(sessionName);
  const [nameState, setNameState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [projects, setProjects] = useState<Project[]>([]);
  const [targetProjectId, setTargetProjectId] = useState('');
  const [isMoving, setIsMoving] = useState(false);
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 열 때마다 지금 값으로 맞춘다. 닫혀 있는 동안 다른 곳에서 바뀌었을 수 있다.
  useEffect(() => {
    if (!open) return;
    setName(sessionName);
    setNameState('idle');
    setTargetProjectId('');
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const body = await readApiJson<{ data?: SessionSettings }>(await api.sessionSettings(sessionId));
        if (!cancelled && body.data) setSettings(body.data);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    if (supportsMove) {
      void (async () => {
        try {
          const response = await api.projects();
          const list = (await response.json()) as Project[];
          if (!cancelled && Array.isArray(list)) setProjects(list);
        } catch {
          // 목록을 못 받으면 옮기기만 못 한다.
        }
      })();
    }
    return () => {
      cancelled = true;
    };
    // sessionName 은 열 때의 값만 쓴다. 고치는 중에 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, supportsMove]);

  const moveChoices = useMemo(
    () => projects
      .filter((candidate) => candidate.projectId !== project?.projectId)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [project?.projectId, projects],
  );

  // 같은 파일이 여러 번 오갔으면 한 번만 보인다.
  const { images, files } = useMemo(() => {
    const seen = new Set<string>();
    const keep = <T extends ChatAttachment & { data?: string }>(item: T) => {
      const key = item.path || item.data || item.name || '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    return {
      images: messages.flatMap((message) => message.images ?? []).filter(keep) as ChatImage[],
      files: messages.flatMap((message) => message.files ?? []).filter(keep),
    };
  }, [messages]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === sessionName.trim()) return;
    setNameState('saving');
    setError(null);
    try {
      const response = await api.renameSession(sessionId, trimmed);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNameState('saved');
    } catch (saveError) {
      setNameState('idle');
      setError(t('sessionSettings.renameFailed', { reason: errorMessage(saveError) }));
    }
  };

  const moveSession = async () => {
    if (!targetProjectId || isMoving) return;
    setIsMoving(true);
    setError(null);
    try {
      // 옮긴 결과는 `session_upserted` 로 돌아와 사이드바와 헤더가 새 프로젝트로 따라간다.
      await readApiJson(await api.moveSession(sessionId, targetProjectId));
      setTargetProjectId('');
    } catch (moveError) {
      setError(t('sessionSettings.moveFailed', { reason: errorMessage(moveError) }));
    } finally {
      setIsMoving(false);
    }
  };

  const updateAutoCompact = async (changes: { everyTurns?: number; tokens?: number }) => {
    setError(null);
    try {
      const body = await readApiJson<{ data?: SessionSettings }>(await api.updateSessionSettings(sessionId, {
        autoCompactEveryTurns: changes.everyTurns,
        autoCompactTokens: changes.tokens,
      }));
      if (body.data) setSettings(body.data);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };

  const canCompact = COMPACTABLE_PROVIDERS.has(provider);
  const autoCompactOn = Boolean(settings && (settings.autoCompactEveryTurns > 0 || settings.autoCompactTokens > 0));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90dvh,44rem)] w-[calc(100vw-1rem)] max-w-lg flex-col overflow-hidden p-0">
        <DialogTitle>{t('sessionSettings.title')}</DialogTitle>
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Settings2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-semibold">{t('sessionSettings.title')}</span>
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

          <Section title={t('sessionSettings.name')}>
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
                aria-label={t('sessionSettings.name')}
              />
              <Button
                type="submit"
                size="sm"
                className="h-9 flex-shrink-0"
                disabled={nameState === 'saving' || !name.trim() || name.trim() === sessionName.trim()}
              >
                {nameState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : nameState === 'saved' ? t('sessionSettings.saved') : t('sessionSettings.save')}
              </Button>
            </form>
          </Section>

          <Section title={t('sessionSettings.location')}>
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
              <div className="truncate font-medium">{project?.displayName ?? t('sessionSettings.noProject')}</div>
              {project?.fullPath && <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>{project.fullPath}</div>}
            </div>
            {supportsMove ? (
              <div className="flex gap-2">
                <select
                  value={targetProjectId}
                  onChange={(event) => setTargetProjectId(event.target.value)}
                  disabled={isProcessing || isMoving || moveChoices.length === 0}
                  aria-label={t('sessionSettings.moveTo')}
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
                >
                  <option value="">{moveChoices.length === 0 ? t('sessionSettings.noOtherProject') : t('sessionSettings.moveTo')}</option>
                  {moveChoices.map((candidate) => (
                    <option key={candidate.projectId} value={candidate.projectId}>{candidate.displayName}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 flex-shrink-0"
                  disabled={!targetProjectId || isProcessing || isMoving}
                  onClick={() => void moveSession()}
                >
                  {isMoving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sessionSettings.move')}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('sessionSettings.moveUnsupported', { provider: providerLabel })}</p>
            )}
            {supportsMove && isProcessing && <p className="text-xs text-muted-foreground">{t('sessionSettings.moveWhileRunning')}</p>}
          </Section>

          {permissionModes.length > 0 && (
            <Section title={t('sessionSettings.permission')}>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('sessionSettings.permission')}>
                {permissionModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={mode === permissionMode}
                    onClick={() => onSelectPermissionMode(mode)}
                    title={t(`codex.descriptions.${mode}`, { defaultValue: '' }) || undefined}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs transition-colors',
                      mode === permissionMode
                        ? 'border-primary/40 bg-primary/15 font-medium text-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {t(`codex.modes.${mode}`, { defaultValue: mode })}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('sessionSettings.permissionHint')}</p>
            </Section>
          )}

          <Section title={t('autoCompact.title')}>
            {!canCompact ? (
              <p className="text-xs text-muted-foreground">{t('autoCompact.unsupported', { provider: providerLabel })}</p>
            ) : settings ? (
              <>
                <AutoCompactFields
                  everyTurns={settings.autoCompactEveryTurns}
                  tokens={settings.autoCompactTokens}
                  tokensOffLabel={t('autoCompact.off')}
                  onChange={(changes) => void updateAutoCompact(changes)}
                />
                <p className="text-xs text-muted-foreground">
                  {autoCompactOn
                    ? t('autoCompact.sessionStatus', { count: settings.turnsSinceCompact })
                    : t('autoCompact.sessionOff')}
                </p>
              </>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </Section>

          <Section title={t('sessionSettings.attachments', { count: images.length + files.length })}>
            {images.length === 0 && files.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('sessionSettings.noAttachments')}</p>
            ) : (
              <div className="space-y-2">
                {images.length > 0 && <ChatMessageImages images={images} projectId={project?.projectId} align="start" />}
                {files.length > 0 && <ChatMessageFiles files={files} />}
              </div>
            )}
            {!allMessagesLoaded && (
              <p className="text-xs text-muted-foreground">
                {t('sessionSettings.attachmentsPartial')}{' '}
                {onLoadAllMessages && (
                  <button type="button" className="underline hover:text-foreground" onClick={onLoadAllMessages}>
                    {t('sessionSettings.loadAll')}
                  </button>
                )}
              </p>
            )}
          </Section>

          <Section title={t('sessionSettings.info')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t('sessionSettings.provider')}</dt>
              <dd className="truncate">{providerLabel}{model ? ` · ${model}` : ''}</dd>
              <dt className="text-muted-foreground">{t('sessionSettings.sessionId')}</dt>
              <dd className="truncate font-mono" title={sessionId}>{sessionId}</dd>
            </dl>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
