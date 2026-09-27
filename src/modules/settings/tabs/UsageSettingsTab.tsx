import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, MessageSquare, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';

import { api } from '@/shared/api';
import { ALL_PROVIDERS } from '@/shared/providerVisibility';
import type { AgentProvider } from '@/shared/types';
import { Button, LLMProviderLogo, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';

type RateLimitWindow = {
  type: string;
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  utilization: number | null;
  resetsAt: string | null;
  observedAt: string;
};

type RateLimitSnapshot = {
  supported: boolean;
  windows: RateLimitWindow[];
  planType?: string;
  /** `live` 는 계정에 직접 물어본 값, `events` 는 실행 중에 쌓인 이벤트. */
  source?: 'live' | 'events';
};

type ContextUsage = {
  used: number;
  total: number;
  model?: string;
  unsupported?: boolean;
};

const PROVIDER_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * Display order and labels for the windows a provider reports. A type missing
 * from here still renders — a newer CLI can add buckets (a per-model weekly
 * window, say) and they appear at the end under their raw name rather than
 * vanishing.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'usage.windows.fiveHour',
  seven_day: 'usage.windows.sevenDay',
  seven_day_opus: 'usage.windows.sevenDayOpus',
  seven_day_sonnet: 'usage.windows.sevenDaySonnet',
  seven_day_fable: 'usage.windows.sevenDayFable',
  overage: 'usage.windows.overage',
};

const WINDOW_ORDER = Object.keys(WINDOW_LABELS);

const sortWindows = (windows: RateLimitWindow[]) =>
  [...windows].sort((a, b) => {
    const rankA = WINDOW_ORDER.indexOf(a.type);
    const rankB = WINDOW_ORDER.indexOf(b.type);
    // Unknown types sort last, then alphabetically among themselves.
    if (rankA === -1 && rankB === -1) return a.type.localeCompare(b.type);
    if (rankA === -1) return 1;
    if (rankB === -1) return -1;
    return rankA - rankB;
  });

const formatResetTime = (isoTimestamp: string | null, locale: string) => {
  if (!isoTimestamp) return null;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
};

function UsageBar({
  label,
  percent,
  status,
  footnote,
}: {
  label: string;
  percent: number | null;
  status: RateLimitWindow['status'];
  footnote?: string | null;
}) {
  const { t } = useTranslation('settings');

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-sm text-muted-foreground">
          {percent === null
            ? t('usage.percentUnknown')
            : t('usage.percentUsed', { percent })}
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            status === 'rejected'
              ? 'bg-destructive'
              : status === 'allowed_warning'
                ? 'bg-orange-500'
                : 'bg-primary',
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>

      {footnote && <p className="text-xs text-muted-foreground">{footnote}</p>}
    </div>
  );
}

function RateLimitWindowBar({ window: usageWindow }: { window: RateLimitWindow }) {
  const { t, i18n } = useTranslation('settings');
  const labelKey = WINDOW_LABELS[usageWindow.type];
  const resetsAt = formatResetTime(usageWindow.resetsAt, i18n.language);

  return (
    <UsageBar
      label={labelKey ? t(labelKey) : usageWindow.type}
      percent={usageWindow.utilization === null
        ? null
        : Math.round(usageWindow.utilization * 100)}
      status={usageWindow.status}
      footnote={resetsAt ? t('usage.resets', { time: resetsAt }) : null}
    />
  );
}

/**
 * 지금 열려 있는 대화가 컨텍스트 윈도우를 얼마나 채웠는지.
 *
 * 위쪽 구독 한도와는 다른 값이라 카드를 따로 세운다. 하나는 요금제가 얼마나
 * 남았는지이고 이것은 이 대화를 얼마나 더 이어갈 수 있는지다. 섞어 두면 같은
 * 것의 두 표현으로 읽힌다.
 */
function ContextUsageSection({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('settings');
  const [usage, setUsage] = useState<ContextUsage | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await api.providers.sessionTokenUsage(sessionId);
        if (!response.ok) return;
        const payload = await response.json();
        const data = payload?.data as ContextUsage | undefined;
        if (!cancelled && data && !data.unsupported) {
          setUsage(data);
        }
      } catch (error) {
        // 구독 한도가 이 화면의 본론이므로, 컨텍스트를 못 읽었다고 오류를 띄우지는 않는다.
        console.error('Failed to load context usage:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const used = Number(usage?.used) || 0;
  const total = Number(usage?.total) || 0;
  // 윈도우가 사용량보다 작게 잡힌 세션에서는 비율을 말할 수 없다.
  const hasWindow = total > 0 && total >= used;

  if (!usage || used <= 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <MessageSquare className="h-5 w-5 text-primary" />
        <div>
          <h3 className="text-base font-medium text-foreground">{t('usage.context.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('usage.context.description')}</p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <UsageBar
          label={hasWindow
            ? `${formatTokenCount(used)} / ${formatTokenCount(total)}`
            : formatTokenCount(used)}
          percent={hasWindow ? Math.round((used / total) * 100) : null}
          status="allowed"
          footnote={hasWindow
            ? t('usage.context.remaining', { tokens: (total - used).toLocaleString() })
            : null}
        />
      </div>
    </div>
  );
}

/** Rendered by Settings for the "usage" tab, showing subscription limit windows. */
export default function UsageSettingsTab() {
  const { t, i18n } = useTranslation('settings');
  const { sessionId } = useParams<{ sessionId: string }>();
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [snapshot, setSnapshot] = useState<RateLimitSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.providers.rateLimits(provider);
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const payload = await response.json();
      const data = payload?.data ?? {};
      setSnapshot({
        supported: data.supported !== false,
        windows: Array.isArray(data.windows) ? data.windows as RateLimitWindow[] : [],
        planType: typeof data.planType === 'string' ? data.planType : undefined,
        source: data.source === 'events' ? 'events' : 'live',
      });
    } catch (loadError) {
      console.error('Failed to load usage limits:', loadError);
      setError(t('usage.loadFailed'));
      setSnapshot(null);
    } finally {
      setIsLoading(false);
    }
  }, [provider, t]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const sortedWindows = useMemo(
    () => (snapshot ? sortWindows(snapshot.windows) : []),
    [snapshot],
  );

  const lastObservedAt = useMemo(() => {
    if (sortedWindows.length === 0) return null;
    const newest = sortedWindows.reduce(
      (latest, current) => (current.observedAt > latest ? current.observedAt : latest),
      sortedWindows[0].observedAt,
    );
    return formatResetTime(newest, i18n.language);
  }, [sortedWindows, i18n.language]);

  const isUnsupported = snapshot?.supported === false;
  // 값이 언제 갱신되는지는 프로바이더가 아니라 어디서 읽었는지에 달렸다. 직접 물어본
  // 값은 새로고침이 바로 먹고, 이벤트로 주운 값은 대화를 한 번 돌려야 움직인다.
  const disclaimer = snapshot?.source === 'events'
    ? t('usage.disclaimer')
    : t('usage.disclaimerLive');

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Gauge className="h-5 w-5 text-primary" />
          <div>
            <h3 className="text-lg font-medium text-foreground">{t('usage.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('usage.description')}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadUsage} disabled={isLoading}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isLoading && 'animate-spin')} />
          {t('usage.refresh')}
        </Button>
      </div>

      <PillBar className="w-full md:w-auto">
        {ALL_PROVIDERS.map((candidate) => (
          <Pill
            key={candidate}
            isActive={provider === candidate}
            onClick={() => setProvider(candidate)}
            className="min-w-0 flex-1 justify-center md:flex-initial"
          >
            <LLMProviderLogo provider={candidate} className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{PROVIDER_NAMES[candidate]}</span>
          </Pill>
        ))}
      </PillBar>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {!error && isUnsupported && (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground">
            {t('usage.unsupported.title', { provider: PROVIDER_NAMES[provider] })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{t('usage.unsupported.description')}</p>
        </div>
      )}

      {!error && !isLoading && !isUnsupported && sortedWindows.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground">{t('usage.empty.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('usage.empty.descriptionLive')}
          </p>
        </div>
      )}

      {sortedWindows.length > 0 && (
        <div className="space-y-5 rounded-lg border border-border p-4">
          {snapshot?.planType && (
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('usage.plan', { plan: snapshot.planType })}
            </p>
          )}
          {sortedWindows.map((usageWindow) => (
            <RateLimitWindowBar key={usageWindow.type} window={usageWindow} />
          ))}
        </div>
      )}

      {!isUnsupported && (
        <p className="text-xs text-muted-foreground">
          {lastObservedAt
            ? `${disclaimer} · ${t('usage.lastUpdated', { time: lastObservedAt })}`
            : disclaimer}
        </p>
      )}

      {sessionId && (
        <div className="border-t border-border pt-6">
          <ContextUsageSection sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}
