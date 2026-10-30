import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, KeyboardEvent, MouseEvent, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, Minimize2, Settings2, Square, UserPlus } from 'lucide-react';

import {
  ChatComposer,
  CommandResultModal,
  MessageComponent,
  createCachedDiffCalculator,
  grantClaudeToolPermission,
  normalizedToChatMessages,
  useChatComposerState,
  useChatProviderState,
} from '@/modules/chat';
import { ROOM_MAX_PARTICIPANTS } from '@/shared/constants';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { applyRoomDetailToIndex } from '@/shared/hooks/useRoomIndex';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  Project,
  ProjectSession,
  RoomDetail,
  RoomMessage,
  RoomParticipant,
  RoomPermissionMode,
  SessionNavigationOptions,
} from '@/shared/types';
import { Button } from '@/shared/ui';
import { cn, isImageAttachment } from '@/shared/utils';
import { useHostHistory } from '@/modules/rooms/hooks/useHostHistory';
import { useRoom } from '@/modules/rooms/hooks/useRoom';
import { useSessionTokenUsage } from '@/modules/rooms/hooks/useSessionTokenUsage';
import InviteParticipantModal from '@/modules/rooms/InviteParticipantModal';
import { ParticipantBadge, participantColor } from '@/modules/rooms/ParticipantBadge';
import { ROOM_PERMISSION_LABEL_KEYS, ROOM_PERMISSION_MODES } from '@/modules/rooms/utils/roomPermissions';
import { foldLiveTurn } from '@/modules/rooms/utils/roomLiveTurn';
import ParticipantSettingsPanel from '@/modules/rooms/ParticipantSettingsPanel';
import RoomTurnCard from '@/modules/rooms/RoomTurnCard';
import {
  applyMention,
  filterMentionCandidates,
  findMentionQuery,
  splitByMentions,
} from '@/modules/rooms/utils/roomMentions';
import type { MentionQuery } from '@/modules/rooms/utils/roomMentions';

type RoomInterfaceProps = {
  /** The room host session currently selected in the workspace. */
  hostSessionId: string;
  /** The same host session as a session record; slash commands run against it. */
  hostSession?: ProjectSession | null;
  selectedProject: Project;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  // Same loose signature as ChatInterface: the workspace's opener takes diff info typed by the code editor.
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
};

const MAX_AUTO_TURN_CHOICES = [3, 5, 10, 20];

/**
 * The workspace header leaves an empty spot with this id, left of the tabs. The
 * participant strip is portalled there so the room toolbar keeps its width for
 * the settings instead of clipping the members.
 */
export const ROOM_HEADER_SLOT_ID = 'room-header-participants';
/** Mirrors the server's auto-turn cap, so the field refuses what the server would. */
const MAX_AUTO_TURNS_LIMIT = 100;

/**
 * The auto-turn limit as a free number field, with the old presets offered as
 * suggestions. It commits on Enter or blur rather than per keystroke, so typing
 * "15" does not briefly set the limit to 1. The loop reads the limit before
 * every turn, so changing it mid-round takes effect on the next turn.
 */
function TurnLimitInput({ value, label, onCommit }: { value: number; label: string; onCommit: (next: number) => void }) {
  // What the user is typing; null while the field shows the saved value.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const next = Math.round(Number(draft));
    setDraft(null);
    if (Number.isFinite(next) && next >= 1 && next <= MAX_AUTO_TURNS_LIMIT && next !== value) {
      onCommit(next);
    }
  };

  return (
    <>
      <input
        type="number"
        min={1}
        max={MAX_AUTO_TURNS_LIMIT}
        step={1}
        list="room-max-auto-turn-choices"
        aria-label={label}
        title={label}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(null);
        }}
        className="w-14 rounded border border-border bg-background px-1 py-0.5 text-xs"
      />
      <datalist id="room-max-auto-turn-choices">
        {MAX_AUTO_TURN_CHOICES.map((choice) => <option key={choice} value={choice} />)}
      </datalist>
    </>
  );
}

// MessageComponent draws a "Claude"/"Codex" header unless the previous row is
// of the same type. Room rows carry their own name badge, so they are always
// rendered as if grouped under this anchor.
const GROUPED_ASSISTANT_ANCHOR: ChatMessage = { type: 'assistant', timestamp: 0 };

/** Drops the handoff marker the engine already read from a reply's last line; the card shows it as a footer instead. */
function stripHandoffMarker(text: string): string {
  const lines = text.trimEnd().split('\n');
  const last = (lines.at(-1) ?? '').replace(/\s*\[(DONE|PASS)\]\s*$/i, '');
  if (/^\s*@[^\s@]+\s*$/u.test(last) || !last.trim()) {
    lines.pop();
  } else {
    lines[lines.length - 1] = last;
  }
  return lines.join('\n').trimEnd();
}

/**
 * Splits a reply into what was said while working and the conclusion. The
 * server stores both joined in `text` and the last message as `finalText`.
 */
function splitReply(message: RoomMessage): { process: string; conclusion: string } {
  const conclusion = message.finalText?.trim();
  const full = message.text.trim();
  if (!conclusion || !full.endsWith(conclusion) || conclusion === full) {
    return { process: '', conclusion: message.handoff ? stripHandoffMarker(full) : full };
  }
  return {
    process: full.slice(0, full.length - conclusion.length).trim(),
    conclusion: message.handoff ? stripHandoffMarker(conclusion) : conclusion,
  };
}

// The composer's own permission menu is not shown in a room (each participant
// has its own preset), so these stand in for the chat-session permission hooks.
const noop = () => {};
const keepPermissionMode = (_provider: unknown, mode: PermissionMode | string) => mode as PermissionMode;
// Room permission prompts come from useRoom, not from the composer's state.
const ignorePermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>> = noop;

/**
 * Used by the project-workspace module in place of ChatInterface when the
 * selected session hosts a team room: one shared timeline with per-speaker
 * badges, the running participant's live turn, its permission prompts, the
 * per-participant settings under the member chips, and the same composer a
 * chat uses, which accepts messages at any time.
 */
export function RoomInterface({
  hostSessionId,
  hostSession = null,
  selectedProject,
  onNavigateToSession,
  onFileOpen,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
}: RoomInterfaceProps) {
  const { t } = useTranslation('chat');
  const { sendMessage } = useWebSocket();
  const {
    detail,
    lives,
    pendingPermissions,
    loadError,
    postMessage,
    interrupt,
    stop,
    compact,
    updateSettings,
    updateParticipant,
    removeParticipant,
    applyDetail,
    answerPermission,
  } = useRoom(hostSessionId);

  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  // Each running session's stream as transcript rows, in the server's order.
  const liveTurns = useMemo(
    () => lives.map((buffer) => ({ sessionId: buffer.sessionId, messages: normalizedToChatMessages(buffer.frames) })),
    [lives],
  );

  // The conversation the host had before it became a room, folded away at the
  // top of the timeline so turning a chat into a room does not hide it.
  const hostHistory = useHostHistory(hostSessionId, detail?.room.createdAt ?? null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMessages = useMemo(
    () => (hostHistory.state.status === 'loaded' ? normalizedToChatMessages(hostHistory.state.messages) : []),
    [hostHistory.state],
  );

  // The `@` mention being typed at the caret, which drives the suggestion list.
  const [mention, setMention] = useState<MentionQuery | null>(null);
  // Highlighted suggestion while the mention list is open.
  const [mentionIndex, setMentionIndex] = useState(0);
  // Last send/stop/settings failure, shown above the composer until the next attempt.
  const [actionError, setActionError] = useState<string | null>(null);
  // Whether the add-participant modal is open.
  const [inviteOpen, setInviteOpen] = useState(false);
  // Replies whose folded "work in progress" part the user opened.
  const [openProcessIds, setOpenProcessIds] = useState<Set<number>>(() => new Set());
  // 진행 중인 차례에서 지난 도구 호출까지 펼쳐 둔 세션. 비어 있으면 최근 것만 보인다.
  const [expandedLiveTurns, setExpandedLiveTurns] = useState<Set<string>>(() => new Set());
  // The participant whose settings card is open beside the member list; one at a time.
  const [settingsParticipantId, setSettingsParticipantId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The live turn's card, scrolled into view from the "working" bar over the composer.
  const liveCardRef = useRef<HTMLDivElement | null>(null);
  // Follow new content only while the user is already at the bottom.
  const followBottomRef = useRef(true);

  const participants = useMemo(() => detail?.participants ?? [], [detail]);
  const formerParticipantIds = useMemo(
    () => new Set((detail?.formerParticipants ?? []).map((participant) => participant.participantId)),
    [detail],
  );
  // Former members stay resolvable so their earlier entries keep a name.
  const participantsById = useMemo(
    () => new Map([...(detail?.formerParticipants ?? []), ...participants].map((participant) => [participant.participantId, participant])),
    [detail, participants],
  );
  const roomState = detail?.state ?? null;
  const isRunning = roomState?.status === 'running';
  // Everyone working now; several while split work or opinions run in parallel.
  const activeParticipants = (roomState?.activeParticipantIds ?? (roomState?.activeParticipantId ? [roomState.activeParticipantId] : []))
    .map((participantId) => participantsById.get(participantId))
    .filter((participant): participant is RoomParticipant => Boolean(participant));
  const activeParticipant = activeParticipants[0];
  const participantBySession = (sessionId: string) => participants.find((participant) => participant.sessionId === sessionId);
  const isParticipantActive = (participantId: string) => activeParticipants.some((participant) => participant.participantId === participantId);
  const settingsParticipant = participants.find((participant) => participant.participantId === settingsParticipantId);
  // A finished turn always lands a timeline entry, so this doubles as "refresh token usage".
  const timelineLength = detail?.messages.length ?? 0;

  const mentionCandidates = useMemo(
    () => (mention ? filterMentionCandidates(participants.map((p) => p.displayName), mention.query) : []),
    [mention, participants],
  );
  const isMentionListOpen = Boolean(mention && mentionCandidates.length > 0);

  useEffect(() => {
    const container = scrollRef.current;
    if (container && followBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [detail?.messages.length, liveTurns]);

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

  // Host-side state for the composer: slash commands, `/model` and `/cost`
  // resolve against the host session, the way they would in its own chat.
  const hostProvider = useChatProviderState({ selectedSession: hostSession, selectedProject });
  const hostTokenUsage = useSessionTokenUsage(hostSessionId, timelineLength);

  /**
   * Where the composer's send goes. Slash commands (and the text a custom
   * command expands into) run as written in the host session; everything else
   * is a room message the participants answer in turn.
   */
  const submitToRoom = useCallback(async (submission: { content: string; attachments: unknown[]; fromCommand: boolean }) => {
    setActionError(null);
    try {
      await postMessage({
        content: submission.content,
        attachments: submission.attachments,
        hostCommand: submission.fromCommand || submission.content.trimStart().startsWith('/'),
      });
      setMention(null);
      followBottomRef.current = true;
    } catch (error) {
      setActionError(t('rooms.sendFailed', { error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }, [postMessage, t]);

  // Command output and upload failures the composer would add to a chat
  // transcript; a room has no local transcript, so they show as the notice.
  const showComposerMessage = useCallback((message: ChatMessage) => {
    if (typeof message.content === 'string' && message.content) {
      setActionError(message.content);
    }
  }, []);

  const composer = useChatComposerState({
    selectedProject,
    selectedSession: hostSession,
    currentSessionId: hostSessionId,
    provider: hostProvider.provider,
    permissionMode: hostProvider.permissionMode,
    cyclePermissionMode: noop,
    resolvePermissionModeForProvider: keepPermissionMode,
    currentProviderModel: hostProvider.currentProviderModel,
    currentProviderEffort: hostProvider.currentProviderEffort,
    // The server queues a message sent mid-turn itself, so the composer never holds one back.
    isLoading: false,
    canAbortSession: false,
    tokenBudget: hostTokenUsage,
    sendMessage,
    sendByCtrlEnter,
    onFileOpen,
    onShowSettings,
    scrollToBottom: noop,
    addMessage: showComposerMessage,
    setIsUserScrolledUp: noop,
    setPendingPermissionRequests: ignorePermissionRequests,
    submitOverride: submitToRoom,
  });

  const updateMentionFromCaret = (text: string, caret: number) => {
    setMention(findMentionQuery(text, caret));
    setMentionIndex(0);
  };

  const chooseMention = (name: string) => {
    const textarea = composer.textareaRef.current;
    if (!mention || !textarea) return;
    const next = applyMention(composer.input, textarea.selectionStart ?? composer.input.length, mention, name);
    composer.setInput(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    composer.handleInputChange(event);
    updateMentionFromCaret(event.target.value, event.target.selectionStart ?? event.target.value.length);
  };

  const handleTextareaClick = (event: MouseEvent<HTMLTextAreaElement>) => {
    composer.handleTextareaClick(event);
    const target = event.currentTarget;
    updateMentionFromCaret(target.value, target.selectionStart ?? target.value.length);
  };

  // Participant mentions take the keyboard while their list is open; every
  // other key (send, history, file mentions, commands) is the composer's.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!event.nativeEvent.isComposing && isMentionListOpen) {
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
    composer.handleKeyDown(event);
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
  // A roster member waiting to be called has no session to open yet.
  const openParticipantSession = (sessionId: string | null) => {
    if (!sessionId) return;
    onNavigateToSession?.(sessionId, sessionId === hostSessionId ? { view: 'chat' } : undefined);
  };

  /**
   * 입력창 뒤에 깔리는 겹글. 입력한 `@이름` 을 그 참가자 색으로 칠해, 누구를
   * 부르는 글인지 보내기 전에 보이게 한다. 글자는 textarea 가 그리므로 여기서는
   * 자리를 똑같이 차지하는 투명한 글자에 배경만 입힌다.
   *
   * 멘션이 아닌 부분은 채팅의 파일 멘션 겹글에 그대로 넘긴다 — 룸에서도 파일을
   * 붙여 말할 수 있어야 한다.
   */
  const renderRoomInput = (text: string) => {
    const segments = splitByMentions(text, participants.map((participant) => participant.displayName));
    if (segments.length === 0) {
      return composer.renderInputWithMentions(text);
    }
    return segments.map((segment, index) => {
      if (!segment.mentionedName) {
        return <span key={`text-${index}`}>{composer.renderInputWithMentions(segment.text)}</span>;
      }
      const participant = participants.find((candidate) => candidate.displayName === segment.mentionedName);
      return (
        <span
          key={`mention-${index}`}
          className={cn(
            '-ml-0.5 box-decoration-clone rounded-md px-0.5 text-transparent',
            participantColor(participant).mention,
          )}
        >
          {segment.text}
        </span>
      );
    });
  };

  const handleInvited = (nextDetail: RoomDetail) => {
    applyDetail(nextDetail);
    applyRoomDetailToIndex(nextDetail);
  };

  const handleLeave = (participantId: string) => {
    void runAction(async () => {
      const nextDetail = await removeParticipant(participantId);
      if (nextDetail) {
        // 그 참가자는 룸에 남은 채 대기로 내려간다. 사이드바도 룸 밑에 그대로 둔다.
        applyRoomDetailToIndex(nextDetail);
      }
      setSettingsParticipantId(null);
    });
  };

  // Where the participant strip goes: the header's spot once it is in the page,
  // inline in the toolbar until then (or in a layout without that header).
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderSlot(document.getElementById(ROOM_HEADER_SLOT_ID));
  }, []);

  // 참가자 목록은 버튼 하나로 접어 둔다. 칩을 늘어놓으면 헤더 폭을 넘겨 가로
  // 스크롤에 가려졌다. 바깥을 누르거나 Escape 로 닫는다.
  const [membersOpen, setMembersOpen] = useState(false);
  const membersRef = useRef<HTMLDivElement | null>(null);
  const membersMenuRef = useRef<HTMLDivElement | null>(null);
  // 목록은 body 로 portal 해 띄운다. 헤더 안에 두면 아래 대화 카드의 고정
  // 머리줄이 그 위를 덮는다. 위치는 버튼 오른쪽 아래에 맞춘다.
  const [membersMenuPos, setMembersMenuPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!membersOpen) return;
    const place = () => {
      const rect = membersRef.current?.getBoundingClientRect();
      if (rect) setMembersMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [membersOpen]);
  // 설정은 목록에 붙은 하위 메뉴라, 목록이 닫히면 같이 닫는다.
  const settingsParticipantIdRef = useRef(settingsParticipantId);
  settingsParticipantIdRef.current = settingsParticipantId;
  useEffect(() => {
    if (!membersOpen) setSettingsParticipantId(null);
  }, [membersOpen]);
  useEffect(() => {
    if (!membersOpen) return;
    const closeOnOutside = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (membersRef.current?.contains(target) || membersMenuRef.current?.contains(target)) return;
      // 설정 안의 모델 메뉴는 body 에 따로 portal 된다. 거기를 누른 것은 바깥이 아니다.
      if (target instanceof Element && target.closest('[role="menu"]')) return;
      setMembersOpen(false);
    };
    // Escape 는 한 겹씩 닫는다: 모델 메뉴 → 설정 → 목록.
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="menu"]')) return;
      if (settingsParticipantIdRef.current) setSettingsParticipantId(null);
      else setMembersOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [membersOpen]);

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
          message={{
            type: 'user',
            content: message.text,
            images: (message.attachments ?? []).filter(isImageAttachment),
            files: (message.attachments ?? []).filter((attachment) => !isImageAttachment(attachment)),
            timestamp: message.createdAt,
          }}
          prevMessage={null}
          createDiff={createDiff}
          provider="claude"
          selectedProject={selectedProject}
        />
      );
    }

    const participant = participantsById.get(message.speaker);
    const { process, conclusion } = splitReply(message);
    const processOpen = openProcessIds.has(message.id);
    const toggleProcess = () => setOpenProcessIds((previous) => {
      const next = new Set(previous);
      if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
      return next;
    });
    const renderText = (content: string) => (
      <MessageComponent
        message={{ type: 'assistant', content, timestamp: message.createdAt }}
        prevMessage={GROUPED_ASSISTANT_ANCHOR}
        createDiff={createDiff}
        provider={participant?.provider ?? 'claude'}
        selectedProject={selectedProject}
        onFileOpen={onFileOpen}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
      />
    );
    const handoffTarget = message.handoff?.kind === 'mention' ? participantsById.get(message.handoff.participantId) : undefined;
    const kindLabel = message.turnKind === 'plan'
      ? t('rooms.kindPlan')
      : message.turnKind === 'task'
        ? t('rooms.kindTask')
        : message.turnKind === 'comment'
          ? t('rooms.kindComment')
          : message.turnKind === 'summary' ? t('rooms.kindSummary') : null;

    return (
      <RoomTurnCard
        key={message.id}
        participant={participant}
        header={(
          <>
            <ParticipantBadge
              participant={participant}
              hostLabel={t('rooms.host')}
              leftLabel={formerParticipantIds.has(message.speaker) ? t('rooms.formerParticipant') : undefined}
            />
            {kindLabel && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{kindLabel}</span>}
            {message.task && (
              <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                {message.task.canEdit ? t('rooms.taskCanEdit') : t('rooms.taskReadOnly')}
              </span>
            )}
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
          </>
        )}
        footer={message.handoff ? (
          message.handoff.kind === 'mention' ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <ArrowRight className="h-3.5 w-3.5" />
              <ParticipantBadge participant={handoffTarget} hostLabel={t('rooms.host')} />
              {t('rooms.handoffTo')}
            </span>
          ) : message.handoff.kind === 'done' ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('rooms.handoffDone')}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('rooms.handoffPass')}</span>
          )
        ) : undefined}
      >
        {message.task && (
          <p className="mx-2 whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
            {message.task.text}
          </p>
        )}
        {process && (
          <div className="px-2">
            <button
              type="button"
              onClick={toggleProcess}
              aria-expanded={processOpen}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {processOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {processOpen ? t('rooms.hideWorkProcess') : t('rooms.showWorkProcess')}
            </button>
            {processOpen && <div className="mt-1 opacity-80">{renderText(process)}</div>}
          </div>
        )}
        {conclusion && renderText(conclusion)}
      </RoomTurnCard>
    );
  };

  const isFull = participants.length >= ROOM_MAX_PARTICIPANTS;
  const waitingUserMessage = isRunning && roomState?.pendingUserMessage
    ? [...detail.messages].reverse().find((message) => message.speaker === 'user')
    : undefined;

  const phase = roomState?.phase ?? (isRunning ? 'turn' : 'idle');
  const statusLabel = phase === 'working'
    ? t('rooms.statusSplitWorking', { count: activeParticipants.length })
    : phase === 'discussing'
      ? t('rooms.statusDiscussing')
      : phase === 'summarizing'
        ? t('rooms.statusSummarizing', { name: activeParticipant?.displayName ?? '…' })
        : t('rooms.statusWorking', { name: activeParticipant?.displayName ?? '…' });
  const phaseLabel = phase === 'working'
    ? t('rooms.phaseWorking')
    : phase === 'discussing'
      ? t('rooms.phaseDiscussing')
      : phase === 'summarizing' ? t('rooms.phaseSummarizing') : t('rooms.answering');
  // The chip on each live card; a plain turn needs none.
  const phaseChip = phase === 'working'
    ? t('rooms.kindTask')
    : phase === 'discussing'
      ? t('rooms.kindComment')
      : phase === 'summarizing' ? t('rooms.kindSummary') : null;

  const composerNotices = (
    <>
      {isRunning && activeParticipants.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border/50 bg-card/80 px-3 py-1.5 text-xs">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          {activeParticipants.map((participant) => (
            <ParticipantBadge key={participant.participantId} participant={participant} hostLabel={t('rooms.host')} />
          ))}
          <span className="text-muted-foreground">{phaseLabel}</span>
          <button
            type="button"
            onClick={() => liveCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {t('rooms.jumpToLive')}
          </button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="mx-auto mb-2 max-w-[54.25rem] px-1 text-xs text-red-600 dark:text-red-400">{actionError}</p>
      )}
      {waitingUserMessage && (
        <div className="mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
          <div className="flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-primary/70">
                {t('rooms.pendingTitle')}
                <span className="font-normal text-muted-foreground/60"> · {t('rooms.pendingHint')}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 break-words text-sm text-foreground/90">{waitingUserMessage.text}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs"
              title={t('rooms.interruptNowTitle')}
              onClick={() => void runAction(interrupt)}
            >
              {t('rooms.interruptNow')}
            </Button>
          </div>
        </div>
      )}
    </>
  );

  const participantStrip = (
    <div ref={membersRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setMembersOpen((open) => !open)}
        aria-expanded={membersOpen}
        aria-haspopup="true"
        title={t('rooms.membersButtonTitle')}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full border border-border/60 px-2.5 text-xs transition-colors hover:bg-accent/60',
          membersOpen && 'bg-accent/60',
        )}
      >
        {/* 접혀 있어도 누가 있는지 색 점으로 보이고, 일하는 참가자는 점이 깜빡인다. */}
        <span className="flex items-center -space-x-0.5" aria-hidden>
          {participants.map((participant) => (
            <span
              key={participant.participantId}
              className={cn(
                'h-2 w-2 rounded-full ring-1 ring-background',
                participantColor(participant).dot,
                participant.status === 'standby' && !participant.sessionId && 'opacity-40',
                isParticipantActive(participant.participantId) && 'animate-pulse',
              )}
            />
          ))}
        </span>
        <span className="font-medium">{t('rooms.membersButton', { count: participants.length })}</span>
        {activeParticipants.length > 0 && (
          <span className="text-muted-foreground">· {t('rooms.membersWorking', { count: activeParticipants.length })}</span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', membersOpen && 'rotate-180')} />
      </button>

      {membersOpen && membersMenuPos && createPortal(
        // 설정은 하위 메뉴처럼 목록 왼쪽에 붙는다. 버튼이 헤더 오른쪽 끝에 있어
        // 오른쪽에는 자리가 없다.
        <div
          ref={membersMenuRef}
          style={{ top: membersMenuPos.top, right: membersMenuPos.right }}
          className="fixed z-50 flex items-start gap-1"
        >
          {settingsParticipant && (
            <div className="max-h-[80vh] w-80 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
              <ParticipantSettingsPanel
                key={settingsParticipant.participantId}
                participant={settingsParticipant}
                isSpeaking={isRunning && isParticipantActive(settingsParticipant.participantId)}
                refreshKey={timelineLength}
                onChangePermission={(mode: RoomPermissionMode) => void runAction(
                  () => updateParticipant(settingsParticipant.participantId, { permissionMode: mode }),
                )}
                onChangeProfile={(profile) => void runAction(
                  () => updateParticipant(settingsParticipant.participantId, profile),
                )}
                onCompact={() => void runAction(() => compact(settingsParticipant.participantId))}
                onLeave={() => handleLeave(settingsParticipant.participantId)}
                onOpenSession={() => {
                  setMembersOpen(false);
                  openParticipantSession(settingsParticipant.sessionId);
                }}
                onClose={() => setSettingsParticipantId(null)}
              />
            </div>
          )}
        <div className="w-72 overflow-hidden rounded-xl border border-border/50 bg-card/95 py-1 shadow-lg backdrop-blur-md">
          <ul className="max-h-[60vh] overflow-y-auto">
            {participants.map((participant) => {
              const settingsOpen = settingsParticipantId === participant.participantId;
              return (
                <li
                  key={participant.participantId}
                  className={cn(
                    'flex items-center gap-1 px-1.5 py-0.5',
                    // 명단에서 기다리는 멤버는 흐리게 둔다.
                    participant.status === 'standby' && (participant.sessionId ? 'opacity-75' : 'opacity-60'),
                  )}
                >
                  <button
                    type="button"
                    disabled={!participant.sessionId}
                    onClick={() => {
                      setMembersOpen(false);
                      openParticipantSession(participant.sessionId);
                    }}
                    title={participant.sessionId ? t('rooms.openSession') : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent',
                      isParticipantActive(participant.participantId) && 'bg-primary/10',
                    )}
                  >
                    <ParticipantBadge
                      participant={participant}
                      hostLabel={t('rooms.host')}
                      standbyLabel={t('rooms.standby')}
                    />
                    {isParticipantActive(participant.participantId) && (
                      <Loader2 className="ml-auto h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSettingsParticipantId(settingsOpen ? null : participant.participantId)}
                    aria-pressed={settingsOpen}
                    aria-label={t('rooms.participantSettings', { name: participant.displayName })}
                    title={t('rooms.participantSettings', { name: participant.displayName })}
                    className={cn(
                      'flex-shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                      settingsOpen && 'bg-accent/70 text-foreground',
                    )}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 border-t border-border/50 px-1.5 pt-1">
            <button
              type="button"
              disabled={isFull}
              onClick={() => {
                setMembersOpen(false);
                setInviteOpen(true);
              }}
              title={isFull ? t('rooms.roomFull', { max: ROOM_MAX_PARTICIPANTS }) : t('rooms.inviteTitle')}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {t('rooms.inviteTitle')}
            </button>
          </div>
        </div>
        </div>,
        document.body,
      )}
    </div>
  );

  const mentionList = isMentionListOpen ? (
    <ul className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-border/50 bg-card/95 py-1 shadow-lg backdrop-blur-md" role="listbox">
      {mentionCandidates.map((name, index) => {
        const participant = participants.find((candidate) => candidate.displayName === name);
        return (
          <li key={name} role="option" aria-selected={index === mentionIndex}>
            <button
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                chooseMention(name);
              }}
              className={cn('flex w-full px-3 py-1.5 text-left', index === mentionIndex && 'bg-accent')}
            >
              <ParticipantBadge participant={participant} hostLabel={t('rooms.host')} />
            </button>
          </li>
        );
      })}
    </ul>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        Participant strip and room status, kept to one line. The strip scrolls
        sideways once the room has more members than fit: wrapping onto a second
        line pushed the timeline down and moved the controls every time someone
        joined.
      */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        {headerSlot ? createPortal(participantStrip, headerSlot) : participantStrip}

        <div className="flex flex-shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1" role="status">
            {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
            {isRunning ? statusLabel : t('rooms.statusIdle')}
          </span>
          <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label={t('rooms.collaboration')}>
            {([
              { key: 'splitWork', label: t('rooms.splitWork'), title: t('rooms.splitWorkTitle'), on: detail.room.splitWork },
              { key: 'discussion', label: t('rooms.discussion'), title: t('rooms.discussionTitle'), on: detail.room.discussion },
              { key: 'hostLed', label: t('rooms.hostLed'), title: t('rooms.hostLedTitle'), on: detail.room.hostLed },
              { key: 'autoCompact', label: t('rooms.autoCompact'), title: t('rooms.autoCompactTitle'), on: detail.room.autoCompact },
            ] as const).map((toggle) => (
              <button
                key={toggle.key}
                type="button"
                aria-pressed={toggle.on}
                title={toggle.title}
                onClick={() => void runAction(() => updateSettings({ [toggle.key]: !toggle.on }))}
                className={cn(
                  'px-2 py-0.5 transition-colors',
                  toggle.on ? 'bg-primary/15 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {toggle.label}
              </button>
            ))}
          </div>
          {/*
            룸 권한을 한 번에 바꾼다. 참가자별로 따로 둔 권한은 서버가 함께
            지우므로, 한 명만 예전 권한으로 남는 일이 없다.
          */}
          <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label={t('rooms.permissionModeAll')}>
            {ROOM_PERMISSION_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={detail.room.permissionMode === mode}
                title={t('rooms.permissionModeAllTitle')}
                onClick={() => {
                  if (detail.room.permissionMode !== mode) {
                    void runAction(() => updateSettings({ permissionMode: mode }));
                  }
                }}
                className={cn(
                  'px-2 py-0.5 transition-colors',
                  detail.room.permissionMode === mode
                    ? 'bg-primary/15 font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {t(ROOM_PERMISSION_LABEL_KEYS[mode])}
              </button>
            ))}
          </div>
          <span>{t('rooms.turnCount', { count: roomState?.turnCount ?? 0, max: roomState?.maxAutoTurns ?? detail.room.maxAutoTurns })}</span>
          <TurnLimitInput
            value={detail.room.maxAutoTurns}
            label={t('rooms.maxAutoTurnsTitle', { max: MAX_AUTO_TURNS_LIMIT })}
            onCommit={(next) => void runAction(() => updateSettings({ maxAutoTurns: next }))}
          />
          {/*
            참가자마다 자기 세션에 맥락이 쌓인다. 룸은 한 요청에 여럿이 답하므로
            사람 수만큼 빨리 찬다. 이 단추가 모두의 맥락을 한 번에 줄인다.
          */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 flex-shrink-0 gap-1 px-2 text-xs"
            disabled={isRunning}
            title={isRunning ? t('rooms.compactWhileRunning') : t('rooms.compactAllTitle')}
            onClick={() => void runAction(() => compact())}
          >
            <Minimize2 className="h-3.5 w-3.5" />
            {t('rooms.compactAll')}
          </Button>
          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-shrink-0 gap-1 border-red-500/40 px-2 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
              onClick={() => void runAction(stop)}
            >
              <Square className="h-3 w-3 fill-current" />
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

          {detail.messages.length === 0 && liveTurns.length === 0 && (
            <p className="px-3 text-center text-sm text-muted-foreground">{t('rooms.emptyTimeline')}</p>
          )}
          {detail.messages.map(renderRoomMessage)}

          {liveTurns.map((turn, turnIndex) => {
            const participant = participantBySession(turn.sessionId);
            return (
              <div key={turn.sessionId} ref={turnIndex === liveTurns.length - 1 ? liveCardRef : undefined} aria-live="polite">
                <RoomTurnCard
                  participant={participant}
                  live={isRunning}
                  header={(
                    <>
                      <ParticipantBadge participant={participant} hostLabel={t('rooms.host')} />
                      {phaseChip && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{phaseChip}</span>}
                      {isRunning && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t('rooms.answering')}
                        </span>
                      )}
                    </>
                  )}
                >
                  {(() => {
                    // 조사하는 동안 쌓인 지난 도구 호출은 한 줄로 묶는다. 전부 그리면
                    // 참가자 하나가 화면을 통째로 먹고, 지금 무엇을 하는지가 묻힌다.
                    const folded = foldLiveTurn(turn.messages, expandedLiveTurns.has(turn.sessionId));
                    const foldLine = (
                      <button
                        type="button"
                        onClick={() => setExpandedLiveTurns((previous) => {
                          const next = new Set(previous);
                          next.add(turn.sessionId);
                          return next;
                        })}
                        className="mx-2 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <ChevronRight className="h-3.5 w-3.5" />
                        {t('rooms.foldedSteps', { count: folded.hiddenCount })}
                      </button>
                    );
                    return folded.rows.map((message, index) => (
                      <Fragment key={`${String(message.toolId ?? '')}-${index}`}>
                        {index === folded.foldAtIndex && foldLine}
                        <MessageComponent
                          message={message}
                          prevMessage={index === 0 ? GROUPED_ASSISTANT_ANCHOR : folded.rows[index - 1]}
                          createDiff={createDiff}
                          provider={participant?.provider ?? 'claude'}
                          selectedProject={selectedProject}
                          onFileOpen={onFileOpen}
                          showRawParameters={showRawParameters}
                          showThinking={showThinking}
                        />
                      </Fragment>
                    ));
                  })()}
                </RoomTurnCard>
              </div>
            );
          })}
        </div>
      </div>

      {/* The same composer a chat uses; permission prompts ride in its banner. */}
      <ChatComposer
        pendingPermissionRequests={pendingPermissions}
        handlePermissionDecision={answerPermission}
        handleGrantToolPermission={handleGrantToolPermission}
        activity={null}
        isLoading={false}
        onAbortSession={noop}
        tokenBudget={hostTokenUsage}
        onShowTokenUsage={composer.showCostModal}
        isEditingSentMessage={false}
        onCancelEditMessage={noop}
        slashCommandsCount={composer.slashCommandsCount}
        onToggleCommandMenu={composer.handleToggleCommandMenu}
        hasInput={Boolean(composer.input.trim())}
        onClearInput={composer.handleClearInput}
        onSubmit={composer.handleSubmit}
        isDragActive={composer.isDragActive}
        queuedDrafts={composer.queuedDrafts}
        onEditQueuedDraft={composer.editQueuedDraft}
        onDeleteQueuedDraft={composer.deleteQueuedDraft}
        attachedFiles={composer.attachedFiles}
        onRemoveAttachment={(index) =>
          composer.setAttachedFiles((previous) => previous.filter((_, currentIndex) => currentIndex !== index))
        }
        fileErrors={composer.fileErrors}
        showFileDropdown={composer.showFileDropdown && !isMentionListOpen}
        filteredFiles={composer.filteredFiles}
        selectedFileIndex={composer.selectedFileIndex}
        onSelectFile={composer.selectFile}
        filteredCommands={composer.filteredCommands}
        selectedCommandIndex={composer.selectedCommandIndex}
        onCommandSelect={composer.handleCommandSelect}
        onCloseCommandMenu={composer.resetCommandMenuState}
        isCommandMenuOpen={composer.showCommandMenu}
        frequentCommands={composer.commandQuery ? [] : composer.frequentCommands}
        getRootProps={composer.getRootProps as (...args: unknown[]) => Record<string, unknown>}
        getInputProps={composer.getInputProps as (...args: unknown[]) => Record<string, unknown>}
        openAttachmentPicker={composer.openAttachmentPicker}
        inputHighlightRef={composer.inputHighlightRef}
        renderInputWithMentions={renderRoomInput}
        textareaRef={composer.textareaRef}
        input={composer.input}
        onVoiceTranscript={composer.handleVoiceTranscript}
        onInputChange={handleInputChange}
        onTextareaClick={handleTextareaClick}
        onTextareaKeyDown={handleKeyDown}
        onTextareaPaste={composer.handlePaste}
        onTextareaScrollSync={composer.syncInputOverlayScroll}
        onTextareaInput={composer.handleTextareaInput}
        isInputFocused={composer.isInputFocused}
        onInputFocusChange={composer.handleInputFocusChange}
        onCompositionStart={composer.handleCompositionStart}
        onCompositionEnd={composer.handleCompositionEnd}
        placeholder={t('rooms.composerPlaceholder')}
        isTextareaExpanded={composer.isTextareaExpanded}
        sendByCtrlEnter={sendByCtrlEnter}
        aboveInput={composerNotices}
        inputPopover={mentionList}
      />

      <CommandResultModal
        payload={composer.commandModalPayload}
        onClose={composer.closeCommandModal}
        providerModelCatalog={hostProvider.providerModelCatalog}
        providerModelActions={hostProvider.providerModelActions}
        activeProvider={hostProvider.provider}
        activeProviderModel={hostProvider.currentProviderModel}
        currentSessionId={hostSessionId}
        onSelectProviderModel={hostProvider.selectProviderModel}
      />

      <InviteParticipantModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        target={{ kind: 'add', roomId: detail.room.roomId }}
        takenNames={[...participants, ...(detail.formerParticipants ?? [])].map((participant) => participant.displayName)}
        onInvited={handleInvited}
      />
    </div>
  );
}
