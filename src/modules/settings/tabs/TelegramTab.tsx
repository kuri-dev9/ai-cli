import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plug, Plus, Search, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import type {
  TelegramChatDiscovery,
  TelegramSettingsState,
  TelegramSettingsUpdate,
  TelegramTestResult,
} from '@/shared/types';

/** 설정이 없을 때(첫 로드 실패 포함) 화면이 기대는 빈 값. */
const EMPTY_SETTINGS: TelegramSettingsState = {
  enabled: false,
  botToken: '',
  hasToken: false,
  allowedChatIds: [],
  fromEnvironment: false,
  running: false,
  botUsername: null,
};

/**
 * 서버 응답에서 설정 객체를 꺼낸다.
 *
 * 텔레그램 라우트는 설정 객체를 그대로 돌려주지만, 이 저장소의 다른 라우트는
 * `{ success, data }` 봉투에 싸서 준다. 어느 쪽이 와도 화면이 깨지지 않도록
 * 여기서 한 번 벗겨 둔다.
 */
function unwrapSettings(payload: unknown): TelegramSettingsState {
  const raw = payload as { data?: unknown } | null;
  const source = (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object'
    ? raw.data
    : raw) as Partial<TelegramSettingsState> | null;

  return {
    enabled: source?.enabled === true,
    botToken: typeof source?.botToken === 'string' ? source.botToken : '',
    hasToken: source?.hasToken === true,
    allowedChatIds: Array.isArray(source?.allowedChatIds) ? source.allowedChatIds : [],
    fromEnvironment: source?.fromEnvironment === true,
    running: source?.running === true,
    botUsername: typeof source?.botUsername === 'string' ? source.botUsername : null,
  };
}

/** 쉼표·공백·줄바꿈으로 나눠 chat id 후보를 뽑는다. 붙여넣기 한 번으로 여러 개를 넣을 수 있게. */
function parseChatIds(value: string): { ids: number[]; hasInvalid: boolean } {
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  const ids: number[] = [];
  let hasInvalid = false;

  for (const token of tokens) {
    // 음수 chat id(그룹)도 유효하므로 부호는 허용한다.
    if (!/^-?\d+$/.test(token)) {
      hasInvalid = true;
      continue;
    }
    ids.push(Number.parseInt(token, 10));
  }

  return { ids, hasInvalid };
}

const sameIds = (a: number[], b: number[]): boolean => (
  a.length === b.length && a.every((value, index) => value === b[index])
);

/** Rendered by Settings for the "telegram" tab, configuring the Telegram bridge's bot token and chat whitelist. */
export default function TelegramTab() {
  const { t } = useTranslation('settings');

  const [settings, setSettings] = useState<TelegramSettingsState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TelegramTestResult | null>(null);

  // 토큰은 사용자가 입력칸을 건드렸을 때에만 서버로 올린다. 마스킹된 값을 되돌려
  // 보내면 서버가 그걸 무시하도록 돼 있긴 하지만, 애초에 보내지 않는 편이 낫다.
  const [tokenDraft, setTokenDraft] = useState('');
  const [isTokenDirty, setIsTokenDirty] = useState(false);
  const [chatIdDraft, setChatIdDraft] = useState('');
  const [chatIds, setChatIds] = useState<number[]>([]);
  const [chatIdError, setChatIdError] = useState<string | null>(null);

  // "내 chat id 찾기" 결과. 화이트리스트 초안과 따로 둔다 — 여기서 고른 것만
  // 위 목록에 들어가고, 고르지 않은 대화는 아무 영향도 주지 않아야 한다.
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<TelegramChatDiscovery | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverNotice, setDiscoverNotice] = useState<string | null>(null);

  const applySettings = useCallback((next: TelegramSettingsState) => {
    setSettings(next);
    setChatIds(next.allowedChatIds);
    setTokenDraft('');
    setIsTokenDirty(false);
    // 저장하면 브리지가 다시 뜬다. 그 전에 읽어 둔 대화 목록은 이미 낡은
    // 것이므로 붙잡고 있지 않는다.
    setDiscovery(null);
    setDiscoverError(null);
    setDiscoverNotice(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    setError(null);

    void api.telegram
      .settings()
      .then((response) => readApiJson<unknown>(response))
      .then((payload) => {
        if (mounted) {
          applySettings(unwrapSettings(payload));
        }
      })
      .catch(() => {
        if (mounted) {
          setError(t('telegramSettings.loadFailed'));
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [applySettings, t]);

  const save = async (updates: TelegramSettingsUpdate) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.telegram.saveSettings(updates);
      const payload = await readApiJson<unknown>(response);
      applySettings(unwrapSettings(payload));
    } catch {
      setError(t('telegramSettings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const current = settings ?? EMPTY_SETTINGS;
  const isDirty = isTokenDirty || !sameIds(chatIds, current.allowedChatIds);

  const addChatIds = (value: string) => {
    const { ids, hasInvalid } = parseChatIds(value);
    if (hasInvalid) {
      setChatIdError(t('telegramSettings.chatIds.invalid'));
    } else {
      setChatIdError(null);
    }
    if (ids.length === 0) {
      return;
    }

    setChatIds((previous) => [...previous, ...ids.filter((id) => !previous.includes(id))]);
    setChatIdDraft('');
  };

  const removeChatId = (id: number) => {
    setChatIds((previous) => previous.filter((value) => value !== id));
    setChatIdError(null);
  };

  /** 찾은 대화를 화이트리스트 초안에 넣는다. 이미 있으면 다시 넣지 않는다. */
  const addDiscoveredChat = (chatId: number) => {
    setChatIdError(null);
    if (chatIds.includes(chatId)) {
      setDiscoverNotice(t('telegramSettings.chatIds.discover.added'));
      return;
    }
    setDiscoverNotice(null);
    setChatIds((previous) => (previous.includes(chatId) ? previous : [...previous, chatId]));
  };

  const handleDiscover = async () => {
    setIsDiscovering(true);
    setDiscovery(null);
    setDiscoverError(null);
    setDiscoverNotice(null);
    try {
      const response = await api.telegram.discoverChats();
      const payload = await readApiJson<TelegramChatDiscovery>(response);
      setDiscovery({
        chats: Array.isArray(payload?.chats) ? payload.chats : [],
        bridgeRunning: payload?.bridgeRunning === true,
      });
    } catch {
      setDiscoverError(t('telegramSettings.chatIds.discover.failed'));
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleSave = () => {
    const updates: TelegramSettingsUpdate = {};
    // 토큰 입력칸을 건드린 경우에만 담는다.
    if (isTokenDirty) {
      updates.botToken = tokenDraft.trim();
    }
    if (!sameIds(chatIds, current.allowedChatIds)) {
      updates.allowedChatIds = chatIds;
    }
    if (Object.keys(updates).length === 0) {
      return;
    }
    void save(updates);
  };

  const handleClearToken = () => {
    setTokenDraft('');
    setIsTokenDirty(false);
    setTestResult(null);
    void save({ botToken: '' });
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      // 방금 입력한 토큰이 있으면 저장 전에 그 값으로 확인한다.
      const typedToken = isTokenDirty ? tokenDraft.trim() : '';
      const response = await api.telegram.test(typedToken || undefined);
      const payload = await readApiJson<TelegramTestResult>(response);
      setTestResult(payload);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : t('telegramSettings.test.failed'),
      });
    } finally {
      setIsTesting(false);
    }
  };

  const canTest = current.hasToken || (isTokenDirty && tokenDraft.trim().length > 0);
  // 서버는 *저장된* 토큰으로 텔레그램에 묻는다. 방금 입력만 해 둔 토큰으로는
  // 찾을 수 없으므로 "연결 확인"과 달리 저장 여부까지 본다.
  const canDiscover = current.hasToken;

  const statusLabel = (): { text: string; tone: 'ok' | 'warn' | 'muted' } => {
    if (!current.hasToken && !isTokenDirty) {
      return { text: t('telegramSettings.status.noToken'), tone: 'muted' };
    }
    if (current.allowedChatIds.length === 0) {
      return { text: t('telegramSettings.status.noChatIds'), tone: 'warn' };
    }
    if (!current.enabled) {
      return { text: t('telegramSettings.status.disabled'), tone: 'muted' };
    }
    if (current.running) {
      return { text: t('telegramSettings.status.running'), tone: 'ok' };
    }
    return { text: t('telegramSettings.status.stopped'), tone: 'warn' };
  };

  const status = statusLabel();
  const statusToneClass = status.tone === 'ok'
    ? 'text-green-600 dark:text-green-400'
    : status.tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground';

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('telegramSettings.sectionTitle')}
        description={t('telegramSettings.sectionDescription')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('telegramSettings.enableLabel')}
            description={t('telegramSettings.enableDescription')}
          >
            {isLoading && !settings ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                checked={current.enabled}
                onChange={(value) => void save({ enabled: value })}
                ariaLabel={t('telegramSettings.enableAriaLabel')}
                disabled={isSaving}
              />
            )}
          </SettingsRow>

          <div className="space-y-2 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
                {t('telegramSettings.status.prefix')}:{' '}
                <span className={statusToneClass}>
                  {isLoading && !settings ? t('telegramSettings.status.checking') : status.text}
                </span>
              </span>
              {current.botUsername && (
                <span className="rounded-md border border-border px-2 py-1 text-muted-foreground">
                  @{current.botUsername}
                </span>
              )}
              {current.fromEnvironment && (
                <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                  {t('telegramSettings.fromEnvironment')}
                </span>
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('telegramSettings.token.title')}
        description={t('telegramSettings.token.description')}
      >
        <SettingsCard>
          <div className="space-y-3 px-4 py-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">
                {t('telegramSettings.token.label')}
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={tokenDraft}
                placeholder={current.hasToken ? current.botToken : t('telegramSettings.token.placeholder')}
                onChange={(event) => {
                  setTokenDraft(event.target.value);
                  setIsTokenDirty(true);
                  setTestResult(null);
                }}
                disabled={isSaving}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              {current.hasToken && !isTokenDirty && (
                <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t('telegramSettings.token.saved')}
                </span>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleTest()}
                disabled={isTesting || !canTest}
              >
                {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                {isTesting ? t('telegramSettings.test.testing') : t('telegramSettings.test.button')}
              </Button>

              {current.hasToken && !current.fromEnvironment && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearToken}
                  disabled={isSaving}
                  className="text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                  {t('telegramSettings.token.clear')}
                </Button>
              )}
            </div>

            {testResult?.ok && (
              <p className="text-sm text-green-600 dark:text-green-400">
                {t('telegramSettings.test.success')} @{testResult.botUsername}
              </p>
            )}
            {testResult && !testResult.ok && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {testResult.error || t('telegramSettings.test.failed')}
              </p>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('telegramSettings.chatIds.title')}
        description={t('telegramSettings.chatIds.description')}
      >
        <SettingsCard>
          <div className="space-y-3 px-4 py-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={chatIdDraft}
                onChange={(event) => setChatIdDraft(event.target.value)}
                placeholder={t('telegramSettings.chatIds.placeholder')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ',') {
                    event.preventDefault();
                    addChatIds(chatIdDraft);
                  }
                }}
                className="h-10 flex-1"
                inputMode="numeric"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => addChatIds(chatIdDraft)}
                disabled={!chatIdDraft.trim()}
                className="h-10 px-4"
              >
                <Plus className="h-4 w-4" />
                {t('telegramSettings.chatIds.add')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleDiscover()}
                disabled={isDiscovering || !canDiscover}
                className="h-10 px-4"
              >
                {isDiscovering
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Search className="h-4 w-4" />}
                {isDiscovering
                  ? t('telegramSettings.chatIds.discover.loading')
                  : t('telegramSettings.chatIds.discover.button')}
              </Button>
            </div>

            {!canDiscover && (
              <p className="text-xs text-muted-foreground">
                {t('telegramSettings.chatIds.discover.disabled')}
              </p>
            )}

            {chatIdError && (
              <p className="text-sm text-red-600 dark:text-red-400">{chatIdError}</p>
            )}

            {discoverError && (
              <p className="text-sm text-red-600 dark:text-red-400">{discoverError}</p>
            )}

            {discovery && (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
                {/* 브리지가 폴링을 붙들고 있으면 목록을 읽을 수 없다. 이때의 빈
                    목록은 "아무도 말을 걸지 않았다"는 뜻이 아니므로 안내가 다르다. */}
                {discovery.bridgeRunning && (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    {t('telegramSettings.chatIds.discover.bridgeRunning')}
                  </p>
                )}

                {discovery.chats.length > 0 ? (
                  <>
                    <p className="text-xs font-medium text-foreground">
                      {t('telegramSettings.chatIds.discover.resultsTitle')}
                    </p>
                    <ul className="space-y-1">
                      {discovery.chats.map((chat) => (
                        <li key={chat.chatId}>
                          <button
                            type="button"
                            onClick={() => addDiscoveredChat(chat.chatId)}
                            aria-label={t('telegramSettings.chatIds.discover.select', { id: chat.chatId })}
                            className="w-full rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:border-foreground/30 hover:bg-muted"
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              {chat.name && (
                                <span className="text-sm text-foreground">{chat.name}</span>
                              )}
                              {chat.username && (
                                <span className="text-xs text-muted-foreground">@{chat.username}</span>
                              )}
                              <span className="font-mono text-xs text-muted-foreground">
                                {chat.chatId}
                              </span>
                              {chat.isGroup && (
                                <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                  {t('telegramSettings.chatIds.discover.group')}
                                </span>
                              )}
                            </span>
                            {chat.lastText && (
                              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                {chat.lastText}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      {t('telegramSettings.chatIds.discover.hint')}
                    </p>
                  </>
                ) : (
                  // 이 안내가 핵심이다 — 봇은 자기에게 말을 건 적이 있는
                  // 사람만 알 수 있으므로, 먼저 한마디 보내야 목록이 생긴다.
                  !discovery.bridgeRunning && (
                    <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                      {t('telegramSettings.chatIds.discover.empty')}
                    </p>
                  )
                )}

                {discoverNotice && (
                  <p className="text-xs text-muted-foreground">{discoverNotice}</p>
                )}
              </div>
            )}

            {chatIds.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {chatIds.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 py-1 pl-2.5 pr-1 font-mono text-xs text-foreground"
                  >
                    {id}
                    <button
                      type="button"
                      onClick={() => removeChatId(id)}
                      aria-label={t('telegramSettings.chatIds.remove', { id })}
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('telegramSettings.chatIds.empty')}</p>
            )}

            <p className="text-xs text-muted-foreground">{t('telegramSettings.chatIds.help')}</p>
          </div>
        </SettingsCard>
      </SettingsSection>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={!isDirty || isSaving}>
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSaving ? t('telegramSettings.saving') : t('telegramSettings.save')}
        </Button>
        {isDirty && !isSaving && (
          <span className="text-xs text-muted-foreground">{t('telegramSettings.unsaved')}</span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}
