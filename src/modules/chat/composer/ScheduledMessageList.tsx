import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, Clock, X } from 'lucide-react';

import type { ScheduledMessage } from '@/shared/types';
import { cn } from '@/shared/utils';

type ScheduledMessagesPanelProps = {
  scheduledMessages: ScheduledMessage[];
  onCancel: (id: string) => void;
  onClose: () => void;
};

type ScheduledMessagesTriggerProps = {
  scheduledMessages: ScheduledMessage[];
  open: boolean;
  onToggle: () => void;
};

type ScheduleTone = 'soon' | 'hour' | 'today' | 'later';

type ScheduleGroup = {
  key: string;
  label: string;
  at: Date;
  tone: ScheduleTone;
  messages: ScheduledMessage[];
};

/**
 * 남은 시간에 따른 색. 곧 나갈 것일수록 눈에 띄게 — 10분 안쪽은 주황, 한 시간 안쪽은
 * 앱 강조색, 오늘 남은 것은 하늘색, 내일 이후는 보라.
 */
const TONE_STYLES: Record<ScheduleTone, { dot: string; chip: string; item: string }> = {
  soon: {
    dot: 'bg-amber-500',
    chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    item: 'border-amber-500/70 bg-amber-500/[0.06]',
  },
  hour: {
    dot: 'bg-primary',
    chip: 'bg-primary/15 text-primary',
    item: 'border-primary/70 bg-primary/[0.06]',
  },
  today: {
    dot: 'bg-sky-500',
    chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    item: 'border-sky-500/70 bg-sky-500/[0.06]',
  },
  later: {
    dot: 'bg-violet-500',
    chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    item: 'border-violet-500/70 bg-violet-500/[0.06]',
  },
};

function toneFor(at: Date, now: Date): ScheduleTone {
  const ms = at.getTime() - now.getTime();
  if (ms <= 10 * 60_000) return 'soon';
  if (ms <= 60 * 60_000) return 'hour';
  return startOfDay(at) === startOfDay(now) ? 'today' : 'later';
}

/** 할 일 속 `@이름` 을 강조한다. 누가 받을 예약인지가 한눈에 보여야 한다. */
function renderContent(content: string) {
  return content.split(/(@[^\s@[\]`'"(),.:;!?]+)/u).map((part, index) => (
    part.startsWith('@') && part.length > 1
      ? <span key={index} className="font-semibold text-primary">{part}</span>
      : <span key={index}>{part}</span>
  ));
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "오늘 16:04", "내일 09:00", 그 밖에는 "11. 5. 09:00". */
function formatSlot(date: Date, now: Date, labels: { today: string; tomorrow: string }, language: string): string {
  const time = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false });
  const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `${labels.today} ${time}`;
  if (dayDiff === 1) return `${labels.tomorrow} ${time}`;
  return `${date.toLocaleDateString(language, { month: 'numeric', day: 'numeric' })} ${time}`;
}

/** 같은 분에 걸린 예약을 한 칸으로 묶어 시각 순으로 늘어놓는다. */
function groupBySlot(
  messages: ScheduledMessage[],
  now: Date,
  labels: { today: string; tomorrow: string },
  language: string,
): ScheduleGroup[] {
  const groups = new Map<string, ScheduleGroup>();
  const sorted = [...messages].sort(
    (a, b) => new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
  );
  for (const message of sorted) {
    const at = new Date(message.scheduledFor);
    const minute = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes());
    const key = String(minute.getTime());
    const group = groups.get(key)
      ?? { key, label: formatSlot(minute, now, labels, language), at: minute, tone: toneFor(minute, now), messages: [] };
    group.messages.push(message);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 기다리는 예약과 실패한 예약. 둘 다 없으면 버튼도 창도 그리지 않는다. */
export function hasVisibleSchedules(scheduledMessages: ScheduledMessage[]): boolean {
  return scheduledMessages.some((message) => message.status === 'pending' || message.status === 'failed');
}

function useScheduleSummary(scheduledMessages: ScheduledMessage[]) {
  const { t, i18n } = useTranslation('chat');
  const pending = scheduledMessages.filter((message) => message.status === 'pending');
  const failed = scheduledMessages.filter((message) => message.status === 'failed');
  const now = new Date();
  const labels = { today: t('schedule.today'), tomorrow: t('schedule.tomorrow') };
  const groups = groupBySlot(pending, now, labels, i18n.language);
  return { t, pending, failed, groups, now, next: groups[0] };
}

/**
 * Rendered by ChatComposer in the toolbar under the input, next to the token
 * and command buttons: how many messages are waiting and when the next one goes.
 * 누르면 입력창 위로 예약 창(`ScheduledMessagesPanel`)이 열린다.
 */
export const ScheduledMessagesTrigger = forwardRef<HTMLButtonElement, ScheduledMessagesTriggerProps>(
  function ScheduledMessagesTrigger({ scheduledMessages, open, onToggle }, ref) {
    const { t, pending, failed, next } = useScheduleSummary(scheduledMessages);
    if (pending.length === 0 && failed.length === 0) {
      return null;
    }
    const nextTone = next ? TONE_STYLES[next.tone] : null;
    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('schedule.panelTitle', { count: pending.length })}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
          failed.length > 0
            ? 'border-red-500/50 bg-red-500/10 hover:bg-red-500/15'
            : 'border-primary/40 bg-primary/10 hover:bg-primary/15',
          open && 'ring-2 ring-primary/30',
        )}
      >
        {failed.length > 0
          ? <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
          : <Clock className="h-3.5 w-3.5 text-primary" />}
        <span className="font-semibold text-foreground">{t('schedule.badge', { count: pending.length })}</span>
        {next && nextTone && (
          <span className={cn('hidden rounded-full px-1.5 py-0.5 text-[11px] font-medium sm:inline', nextTone.chip)}>
            {t('schedule.next', { when: next.label })}
          </span>
        )}
        {failed.length > 0 && (
          <span className="text-[11px] font-medium text-red-600 dark:text-red-400">{t('schedule.failedCount', { count: failed.length })}</span>
        )}
      </button>
    );
  },
);

/**
 * Rendered by ChatComposer above the input box while the toolbar trigger is
 * open: every waiting message, grouped by the minute it goes out and coloured
 * by how soon, each with its short id and a cancel button.
 *
 * Failed ones are shown too: a message that did not go is exactly the thing a
 * user needs to know about, and the server records why. Dismissing one goes
 * through the same cancel endpoint, so it stays gone across reloads.
 */
export const ScheduledMessagesPanel = forwardRef<HTMLDivElement, ScheduledMessagesPanelProps>(
  function ScheduledMessagesPanel({ scheduledMessages, onCancel, onClose }, ref) {
    const { t, pending, failed, groups, now } = useScheduleSummary(scheduledMessages);
    if (pending.length === 0 && failed.length === 0) {
      return null;
    }

    /** "12분 후", "3시간 후". 하루가 넘으면 날짜 칸이 이미 말해 주므로 붙이지 않는다. */
    const describeRemaining = (at: Date) => {
      const minutes = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
      if (minutes < 1) return t('schedule.dueNow');
      if (minutes < 60) return t('schedule.inMinutes', { count: minutes });
      if (minutes < 24 * 60) return t('schedule.inHours', { count: Math.floor(minutes / 60) });
      return null;
    };

    const renderItem = (message: ScheduledMessage, itemClass: string, isFailed: boolean) => (
      <li
        key={message.id}
        className={cn('group flex items-start gap-2.5 rounded-lg border-l-[3px] px-3 py-2', itemClass)}
      >
        {isFailed && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-3 break-words text-sm leading-snug text-foreground" title={message.content}>
            {renderContent(message.content)}
          </p>
          {/* 룸 참가자에게 보이는 번호와 같다. "#3f2a9c 지워 줘" 처럼 가리킬 수 있다. */}
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80">#{message.id.replace(/-/g, '').slice(0, 6)}</p>
          {isFailed && (
            <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">
              {t('schedule.failed', { reason: message.failureReason ?? '' })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onCancel(message.id)}
          title={isFailed ? t('schedule.dismiss') : t('schedule.cancel')}
          aria-label={isFailed ? t('schedule.dismiss') : t('schedule.cancel')}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-60 transition hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </li>
    );

    return (
      <div
        ref={ref}
        role="dialog"
        aria-label={t('schedule.panelTitle', { count: pending.length })}
        className="absolute bottom-full left-0 right-0 z-50 mb-2 flex max-h-[60vh] flex-col overflow-hidden rounded-xl border border-primary/30 bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-primary/20 bg-gradient-to-r from-primary/15 via-primary/5 to-transparent px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20">
              <Clock className="h-4 w-4 text-primary" />
            </span>
            {t('schedule.panelTitle', { count: pending.length })}
            {failed.length > 0 && (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                {t('schedule.failedCount', { count: failed.length })}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('schedule.collapse')}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 overflow-y-auto px-3 py-3">
          {failed.length > 0 && (
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 px-0.5">
                <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                  {t('schedule.failedGroup')}
                </span>
              </h4>
              <ul className="space-y-1.5">
                {failed.map((message) => renderItem(message, 'border-red-500/70 bg-red-500/[0.06]', true))}
              </ul>
            </section>
          )}
          {groups.map((group) => {
            const tone = TONE_STYLES[group.tone];
            const remaining = describeRemaining(group.at);
            return (
              <section key={group.key}>
                <h4 className="mb-1.5 flex items-center gap-1.5 px-0.5">
                  <span className={cn('h-2 w-2 rounded-full', tone.dot)} aria-hidden />
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', tone.chip)}>{group.label}</span>
                  {remaining && <span className="text-xs text-muted-foreground">{remaining}</span>}
                  {group.messages.length > 1 && (
                    <span className="ml-auto text-xs text-muted-foreground">· {group.messages.length}</span>
                  )}
                </h4>
                <ul className="space-y-1.5">{group.messages.map((message) => renderItem(message, tone.item, false))}</ul>
              </section>
            );
          })}
        </div>
      </div>
    );
  },
);
