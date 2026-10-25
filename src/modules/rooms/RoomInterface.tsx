import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, Loader2, SendIcon, Square, UserPlus } from 'lucide-react';

import {
  MessageComponent,
  PermissionRequestsBanner,
  createCachedDiffCalculator,
  grantClaudeToolPermission,
  normalizedToChatMessages,
} from '@/modules/chat';
import { ROOM_MAX_PARTICIPANTS } from '@/shared/constants';
import { applyRoomDetailToIndex } from '@/shared/hooks/useRoomIndex';
import type {
  ChatMessage,
  Project,
  RoomDetail,
  RoomMessage,
  RoomParticipant,
  RoomPermissionMode,
  SessionNavigationOptions,
} from '@/shared/types';
import { Button, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { useHostHistory } from '@/modules/rooms/hooks/useHostHistory';
import { useRoom } from '@/modules/rooms/hooks/useRoom';
import InviteParticipantModal from '@/modules/rooms/InviteParticipantModal';
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
} from '@/modules/rooms/utils/roomMentions';
import type { MentionQuery } from '@/modules/rooms/utils/roomMentions';

type RoomInterfaceProps = {
  /** The room host session currently selected in the workspace. */
  hostSessionId: string;
  selectedProject: Project;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  // Same loose signature as ChatInterface: the workspace's opener takes diff info typed by the code editor.
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
};

// Name-badge colours by participant position (host first).
const PARTICIPANT_COLORS = [
  { dot: 'bg-sky-500', text: 'text-sky-700 dark:text-sky-300', ring: 'border-sky-500/40 bg-sky-500/10' },
  { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', ring: 'border-amber-500/40 bg-amber-500/10' },
  { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', ring: 'border-emerald-500/40 bg-emerald-500/10' },
  { dot: 'bg-violet-500', text: 'text-violet-700 dark:text-violet-300', ring: 'border-violet-500/40 bg-violet-500/10' },
];

const MAX_AUTO_TURN_CHOICES = [3, 5, 10, 20];

const colorFor = (participant: RoomParticipant | undefined) =>
  PARTICIPANT_COLORS[(participant?.position ?? 0) % PARTICIPANT_COLORS.length];

// MessageComponent draws a "Claude"/"Codex" header unless the previous row is
// of the same type. Room rows carry their own name badge, so they are always
// rendered as if grouped under this anchor.
const GROUPED_ASSISTANT_ANCHOR: ChatMessage = { type: 'assistant', timestamp: 0 };

function ParticipantBadge({ participant, hostLabel }: { participant: RoomParticipant | undefined; hostLabel: string }) {
  const color = colorFor(participant);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', color.dot)} aria-hidden />
      <LLMProviderLogo provider={participant?.provider ?? 'claude'} className="h-3.5 w-3.5 flex-shrink-0" />
      <span className={cn('truncate text-sm font-semibold', color.text)}>{participant?.displayName ?? '?'}</span>
      {participant?.roleName && (
        <span className="truncate text-xs text-muted-foreground">{participant.roleName}</span>
      )}
      {participant?.isHost && (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{hostLabel}</span>
      )}
    </span>
  );
}

/**
 * Used by the project-workspace module in place of ChatInterface when the
 * selected session hosts a team room: one shared timeline with per-speaker
 * badges, the running participant's live turn, its permission prompts and a
 * composer that accepts messages at any time.
 */
export function RoomInterface({
  hostSessionId,
  selectedProject,
  onNavigateToSession,
  onFileOpen,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
}: RoomInterfaceProps) {
  const { t } = useTranslation('chat');
  const {
    detail,
    liveFrames,
    pendingPermissions,
    loadError,
    postMessage,
    stop,
    updateSettings,
    applyDetail,
    answerPermission,
  } = useRoom(hostSessionId);

  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const liveMessages = useMemo(() => normalizedToChatMessages(liveFrames), [liveFrames]);

  // The conversation the host had before it became a room, folded away at the
  // top of the timeline so turning a chat into a room does not hide it.
  const hostHistory = useHostHistory(hostSessionId, detail?.room.createdAt ?? null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMessages = useMemo(
    () => (hostHistory.state.status === 'loaded' ? normalizedToChatMessages(hostHistory.state.messages) : []),
    [hostHistory.state],
  );

  // Composer text, owned here because mention completion rewrites it.
  const [input, setInput] = useState('');
  // The `@` mention being typed at the caret, which drives the suggestion list.
  const [mention, setMention] = useState<MentionQuery | null>(null);
  // Highlighted suggestion while the mention list is open.
  const [mentionIndex, setMentionIndex] = useState(0);
  // In-flight flag for the send request, to block duplicate submits.
  const [sending, setSending] = useState(false);
  // Last send/stop/settings failure, shown above the composer until the next attempt.
  const [actionError, setActionError] = useState<string | null>(null);
  // Whether the add-participant modal is open.
  const [inviteOpen, setInviteOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Follow new content only while the user is already at the bottom.
  const followBottomRef = useRef(true);

  const participants = useMemo(() => detail?.participants ?? [], [detail]);
  const participantsById = useMemo(
    () => new Map(participants.map((participant) => [participant.participantId, participant])),
    [participants],
  );
  const roomState = detail?.state ?? null;
  const isRunning = roomState?.status === 'running';
  const activeParticipant = roomState?.activeParticipantId
    ? participantsById.get(roomState.activeParticipantId)
    : undefined;

  const mentionCandidates = useMemo(
    () => (mention ? filterMentionCandidates(participants.map((p) => p.displayName), mention.query) : []),
    [mention, participants],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (container && followBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [detail?.messages.length, liveMessages]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    followBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  };

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setActionError(null);
    try {
      await postMessage(content);
      setInput('');
      setMention(null);
      followBottomRef.current = true;
    } catch (error) {
      setActionError(t('rooms.sendFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSending(false);
    }
  };

  const updateMentionFromCaret = (text: string, caret: number) => {
    setMention(findMentionQuery(text, caret));
    setMentionIndex(0);
  };

  const chooseMention = (name: string) => {
    const textarea = textareaRef.current;
    if (!mention || !textarea) return;
    const next = applyMention(input, textarea.selectionStart ?? input.length, mention, name);
    setInput(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (mention && mentionCandidates.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMentionIndex((index) => (index + step + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        chooseMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }

    if (event.key === 'Enter') {
      const wantsSend = sendByCtrlEnter ? (event.ctrlKey || event.metaKey) : !event.shiftKey;
      if (wantsSend) {
        event.preventDefault();
        void handleSend();
      }
    }
  };

  const handleGrantToolPermission = useCallback((suggestion: { entry: string; toolName: string }) => {
    if (activeParticipant?.provider !== 'claude') {
      return { success: false };
    }
    return grantClaudeToolPermission(suggestion.entry);
  }, [activeParticipant?.provider]);

  const toggleHistory = () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    // A failed load retries on the next expand.
    if (next && (hostHistory.state.status === 'idle' || hostHistory.state.status === 'error')) {
      followBottomRef.current = false;
      void hostHistory.load();
    }
  };

  // The host's own session opens as the room, so its "open session" asks for the plain chat.
  const openParticipantSession = (sessionId: string) => {
    onNavigateToSession?.(sessionId, sessionId === hostSessionId ? { view: 'chat' } : undefined);
  };

  const handleInvited = (nextDetail: RoomDetail) => {
    applyDetail(nextDetail);
    applyRoomDetailToIndex(nextDetail);
  };

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {loadError ? t('rooms.loadFailed', { error: loadError }) : (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('rooms.loading')}
          </span>
        )}
      </div>
    );
  }

  const renderRoomMessage = (message: RoomMessage) => {
    if (message.speaker === 'user') {
      return (
        <MessageComponent
          key={message.id}
          message={{ type: 'user', content: message.text, timestamp: message.createdAt }}
          prevMessage={null}
          createDiff={createDiff}
          provider="claude"
          selectedProject={selectedProject}
        />
      );
    }

    const participant = participantsById.get(message.speaker);
    return (
      <div key={message.id} className="space-y-1">
        <div className="flex items-center gap-2 px-3 sm:px-0">
          <ParticipantBadge participant={participant} hostLabel={t('rooms.host')} />
          {message.status !== 'complete' && (
            <span className="rounded bg-red-500/10 px-1.5 text-[10px] text-red-600 dark:text-red-400">
              {message.status === 'aborted' ? t('rooms.aborted') : t('rooms.error')}
            </span>
          )}
          {message.sessionId && onNavigateToSession && (
            <button
              type="button"
              onClick={() => openParticipantSession(message.sessionId as string)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              {t('rooms.openSession')}
            </button>
          )}
        </div>
        <MessageComponent
          message={{ type: 'assistant', content: message.text, timestamp: message.createdAt }}
          prevMessage={GROUPED_ASSISTANT_ANCHOR}
          createDiff={createDiff}
          provider={participant?.provider ?? 'claude'}
          selectedProject={selectedProject}
          onFileOpen={onFileOpen}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
        />
      </div>
    );
  };

  const isFull = participants.length >= ROOM_MAX_PARTICIPANTS;
  const permissionOptions: Array<{ value: RoomPermissionMode; label: string }> = [
    { value: 'ask', label: t('rooms.permissionAsk') },
    { value: 'read', label: t('rooms.permissionRead') },
    { value: 'full', label: t('rooms.permissionFull') },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Participant strip and room status */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        {participants.map((participant) => (
          <button
            key={participant.participantId}
            type="button"
            onClick={() => openParticipantSession(participant.sessionId)}
            title={t('rooms.openSession')}
            className={cn(
              'flex max-w-[14rem] items-center rounded-full border px-2 py-0.5',
              colorFor(participant).ring,
              roomState?.activeParticipantId === participant.participantId && 'ring-2 ring-primary/40',
            )}
          >
            <ParticipantBadge participant={participant} hostLabel={t('rooms.host')} />
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-full px-2 text-xs"
          disabled={isFull}
          onClick={() => setInviteOpen(true)}
          title={isFull ? t('rooms.roomFull', { max: ROOM_MAX_PARTICIPANTS }) : t('rooms.inviteTitle')}
        >
          <UserPlus className="h-3.5 w-3.5" />
          {t('rooms.inviteButton')}
        </Button>

        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1" role="status">
            {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
            {isRunning
              ? t('rooms.statusWorking', { name: activeParticipant?.displayName ?? '…' })
              : t('rooms.statusIdle')}
          </span>
          <span>{t('rooms.turnCount', { count: roomState?.turnCount ?? 0, max: roomState?.maxAutoTurns ?? detail.room.maxAutoTurns })}</span>
          <select
            aria-label={t('rooms.permissionMode')}
            value={detail.room.permissionMode}
            onChange={(event) => void runAction(() => updateSettings({ permissionMode: event.target.value as RoomPermissionMode }))}
            className="rounded border border-border bg-background px-1 py-0.5 text-xs"
          >
            {permissionOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            aria-label={t('rooms.maxAutoTurns')}
            title={t('rooms.maxAutoTurns')}
            value={detail.room.maxAutoTurns}
            onChange={(event) => void runAction(() => updateSettings({ maxAutoTurns: Number(event.target.value) }))}
            className="rounded border border-border bg-background px-1 py-0.5 text-xs"
          >
            {Array.from(new Set([...MAX_AUTO_TURN_CHOICES, detail.room.maxAutoTurns])).sort((a, b) => a - b).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => void runAction(stop)}
            >
              <Square className="h-3 w-3" />
              {t('rooms.stop')}
            </Button>
          )}
        </div>
      </div>

      {/* Shared timeline */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 px-0 py-4 sm:px-4">
          <div className="space-y-2">
            <button
              type="button"
              onClick={toggleHistory}
              aria-expanded={historyOpen}
              className="mx-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:mx-0"
            >
              {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {historyOpen ? t('rooms.hideHostHistory') : t('rooms.showHostHistory')}
            </button>
            {historyOpen && (
              <>
                {hostHistory.state.status === 'loading' && (
                  <p className="inline-flex items-center gap-2 px-3 text-xs text-muted-foreground sm:px-0">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('rooms.loading')}
                  </p>
                )}
                {hostHistory.state.status === 'error' && (
                  <p className="px-3 text-xs text-red-600 dark:text-red-400 sm:px-0">
                    {t('rooms.hostHistoryFailed', { error: hostHistory.state.error })}
                  </p>
                )}
                {hostHistory.state.status === 'loaded' && historyMessages.length === 0 && (
                  <p className="px-3 text-xs text-muted-foreground sm:px-0">{t('rooms.hostHistoryEmpty')}</p>
                )}
                {historyMessages.map((message, index) => (
                  <MessageComponent
                    key={`history-${index}`}
                    message={message}
                    prevMessage={index === 0 ? null : historyMessages[index - 1]}
                    createDiff={createDiff}
                    provider={participants.find((participant) => participant.isHost)?.provider ?? 'claude'}
                    selectedProject={selectedProject}
                    onFileOpen={onFileOpen}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                  />
                ))}
                {hostHistory.state.status === 'loaded' && (
                  <div className="flex items-center gap-2 px-3 text-[11px] text-muted-foreground sm:px-0">
                    <span className="h-px flex-1 bg-border" />
                    {t('rooms.roomStartsHere')}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
              </>
            )}
          </div>

          {detail.messages.length === 0 && liveMessages.length === 0 && (
            <p className="px-3 text-center text-sm text-muted-foreground">{t('rooms.emptyTimeline')}</p>
          )}
          {detail.messages.map(renderRoomMessage)}

          {liveMessages.length > 0 && (
            <div className="space-y-2" aria-live="polite">
              <div className="flex items-center gap-2 px-3 sm:px-0">
                <ParticipantBadge participant={activeParticipant} hostLabel={t('rooms.host')} />
                {isRunning && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              {liveMessages.map((message, index) => (
                <MessageComponent
                  key={`${String(message.toolId ?? '')}-${index}`}
                  message={message}
                  prevMessage={index === 0 ? GROUPED_ASSISTANT_ANCHOR : liveMessages[index - 1]}
                  createDiff={createDiff}
                  provider={activeParticipant?.provider ?? 'claude'}
                  selectedProject={selectedProject}
                  onFileOpen={onFileOpen}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Permission prompts, hints and composer */}
      <div className="flex-shrink-0 border-t border-border/60 px-3 pb-3 pt-2">
        <div className="mx-auto max-w-4xl">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissions}
            handlePermissionDecision={answerPermission}
            handleGrantToolPermission={handleGrantToolPermission}
          />
          {isRunning && roomState?.pendingUserMessage && (
            <p className="mb-1 text-xs text-muted-foreground">{t('rooms.queuedHint')}</p>
          )}
          {actionError && (
            <p role="alert" className="mb-1 text-xs text-red-600 dark:text-red-400">{actionError}</p>
          )}
          <div className="relative">
            {mention && mentionCandidates.length > 0 && (
              <ul className="absolute bottom-full left-0 mb-1 w-56 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg" role="listbox">
                {mentionCandidates.map((name, index) => {
                  const participant = participants.find((p) => p.displayName === name);
                  return (
                    <li key={name} role="option" aria-selected={index === mentionIndex}>
                      <button
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          chooseMention(name);
                        }}
                        className={cn('flex w-full px-2 py-1 text-left', index === mentionIndex && 'bg-accent')}
                      >
                        <ParticipantBadge participant={participant} hostLabel={t('rooms.host')} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2">
              <textarea
                ref={textareaRef}
                value={input}
                rows={2}
                onChange={(event) => {
                  setInput(event.target.value);
                  updateMentionFromCaret(event.target.value, event.target.selectionStart ?? event.target.value.length);
                }}
                onClick={(event) => updateMentionFromCaret(input, event.currentTarget.selectionStart ?? input.length)}
                onKeyDown={handleKeyDown}
                placeholder={t('rooms.composerPlaceholder')}
                className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-1 text-sm text-foreground focus:outline-none"
              />
              <Button
                size="sm"
                className="h-8 w-8 flex-shrink-0 p-0"
                disabled={!input.trim() || sending}
                onClick={() => void handleSend()}
                aria-label={t('rooms.send')}
                title={t('rooms.send')}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendIcon className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <InviteParticipantModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        target={{ kind: 'add', roomId: detail.room.roomId }}
        takenNames={participants.map((participant) => participant.displayName)}
        onInvited={handleInvited}
      />
    </div>
  );
}
