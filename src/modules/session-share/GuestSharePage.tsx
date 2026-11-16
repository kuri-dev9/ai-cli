import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { AlertCircle, Link2, Loader2, Send, ShieldQuestion, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { GUEST_MESSAGE_MAX_LENGTH } from '@/modules/session-share/guestApi';
import type { GuestMessage } from '@/modules/session-share/guestApi';
import { useGuestSession } from '@/modules/session-share/hooks/useGuestSession';

/**
 * 공유 링크로 들어온 게스트가 보는 화면.
 *
 * 앱의 나머지(사이드바, 설정, 파일 트리)는 없다. 대화와 입력창뿐이다. 본문
 * 렌더러도 앱의 `Markdown` 을 쓰지 않는다 — 그쪽은 파일 열기·명령 팔레트처럼
 * 로그인한 주인의 작업 공간을 전제로 한 기능이 붙어 있다.
 */

function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</ReactMarkdown>
    </div>
  );
}

function MessageRow({ message }: { message: GuestMessage }) {
  const { t } = useTranslation('share');

  if (message.kind === 'tool') {
    return (
      <div className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
        <Wrench className="h-3 w-3 flex-shrink-0" aria-label={t('guest.tool')} />
        <span className="font-medium">{message.toolName}</span>
        {message.detail && <span className="truncate font-mono">{message.detail}</span>}
      </div>
    );
  }

  if (message.kind === 'error') {
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <span className="whitespace-pre-wrap break-words">{message.content}</span>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-3 py-2 text-sm text-foreground dark:bg-gray-800/60">
          <MarkdownBody>{message.content}</MarkdownBody>
        </div>
        {message.source === 'share' && (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Link2 className="h-3 w-3" />
            {t('badge')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm text-foreground">
      <MarkdownBody>{message.content}</MarkdownBody>
    </div>
  );
}

function formatDate(value: string, language: string): string {
  try {
    return new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value;
  }
}

export default function GuestSharePage({ token }: { token: string }) {
  const { t, i18n } = useTranslation('share');
  const session = useGuestSession(token);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const title = session.title || t('guest.untitled');

  useEffect(() => {
    document.title = title;
  }, [title]);

  // 새 줄이 생기면 아래로 따라간다.
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [session.messages.length, session.liveMessages.length, session.draft, session.pendingQuestion]);

  if (session.status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('guest.loading')}
      </div>
    );
  }

  if (session.status === 'notFound' || session.status === 'error') {
    const notFound = session.status === 'notFound';
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold text-foreground">
          {notFound ? t('guest.notFoundTitle') : t('guest.loadFailed')}
        </h1>
        {notFound ? (
          <p className="max-w-sm text-sm text-muted-foreground">{t('guest.notFoundDescription')}</p>
        ) : (
          <button
            type="button"
            onClick={session.reload}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('guest.retry')}
          </button>
        )}
      </div>
    );
  }

  const isTooLong = input.trim().length > GUEST_MESSAGE_MAX_LENGTH;
  const canSend = Boolean(input.trim()) && !isTooLong && !session.isSending && !session.isProcessing;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) {
      return;
    }
    if (await session.send(input)) {
      setInput('');
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중의 Enter 는 글자를 확정하는 것이지 보내는 것이 아니다.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const sendErrorText = session.sendError === 'SHARE_SESSION_BUSY'
    ? t('guest.busy')
    : session.sendError === 'SHARE_MESSAGE_TOO_LONG'
      ? t('guest.tooLong', { max: GUEST_MESSAGE_MAX_LENGTH })
      : session.sendError
        ? `${t('guest.sendFailed')}: ${session.sendError}`
        : null;

  const isEmpty = session.messages.length === 0 && session.liveMessages.length === 0
    && !session.pendingQuestion && !session.draft;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          <p className="text-xs text-muted-foreground">
            {t('guest.subtitle')}
            {session.expiresAt && ` · ${t('guest.expiresAt', { date: formatDate(session.expiresAt, i18n.language) })}`}
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {session.hasMore && (
            <p className="text-center text-xs text-muted-foreground">{t('guest.hasMore')}</p>
          )}
          {isEmpty && (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('guest.empty')}</p>
          )}
          {session.messages.map((message) => <MessageRow key={message.id} message={message} />)}
          {session.liveMessages.map((message, index) => (
            <MessageRow key={`live-${index}-${message.id}`} message={message} />
          ))}
          {session.pendingQuestion && (
            <MessageRow
              message={{
                id: 'pending',
                kind: 'text',
                role: 'user',
                content: session.pendingQuestion,
                timestamp: '',
                source: 'share',
              }}
            />
          )}
          {session.draft && (
            <div className="text-sm text-foreground">
              <MarkdownBody>{session.draft}</MarkdownBody>
            </div>
          )}
          {session.isProcessing && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              {session.awaitingApproval ? (
                <>
                  <ShieldQuestion className="h-4 w-4 text-amber-500" />
                  {t('guest.awaitingApproval')}
                </>
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('guest.working')}
                </>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="border-t border-border px-4 py-3">
        <form onSubmit={(event) => void submit(event)} className="mx-auto max-w-3xl space-y-2">
          {sendErrorText && (
            <p className="text-sm text-red-600 dark:text-red-400">{sendErrorText}</p>
          )}
          {isTooLong && !sendErrorText && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {t('guest.tooLong', { max: GUEST_MESSAGE_MAX_LENGTH })}
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('guest.placeholder')}
              aria-label={t('guest.placeholder')}
              rows={2}
              className="max-h-48 min-h-[44px] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {session.isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {session.isSending ? t('guest.sending') : t('guest.send')}
            </button>
          </div>
        </form>
      </footer>
    </div>
  );
}
