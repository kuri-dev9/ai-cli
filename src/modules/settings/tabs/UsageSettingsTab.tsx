import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';

type RateLimitWindow = {
  type: string;
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  utilization: number | null;
  resetsAt: string | null;
  observedAt: string;
};

/**
 * Display order and labels for the windows the SDK reports. A type missing from
 * here still renders — a newer CLI can add buckets (a per-model weekly window,
 * say) and they appear at the end under their raw name rather than vanishing.
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

function UsageBar({ window: usageWindow }: { window: RateLimitWindow }) {
  const { t, i18n } = useTranslation('settings');
  const labelKey = WINDOW_LABELS[usageWindow.type];
  const label = labelKey ? t(labelKey) : usageWindow.type;
  const percent = usageWindow.utilization === null
    ? null
    : Math.round(usageWindow.utilization * 100);
  const resetsAt = formatResetTime(usageWindow.resetsAt, i18n.language);

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
            usageWindow.status === 'rejected'
              ? 'bg-destructive'
              : usageWindow.status === 'allowed_warning'
                ? 'bg-orange-500'
                : 'bg-primary',
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>

      {resetsAt && (
        <p className="text-xs text-muted-foreground">{t('usage.resets', { time: resetsAt })}</p>
      )}
    </div>
  );
}

/** Rendered by Settings for the "usage" tab, showing subscription limit windows. */
export default function UsageSettingsTab() {
  const { t, i18n } = useTranslation('settings');
  const [windows, setWindows] = useState<RateLimitWindow[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.providers.rateLimits('claude');
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const payload = await response.json();
      const received = Array.isArray(payload?.data?.windows) ? payload.data.windows : [];
      setWindows(received as RateLimitWindow[]);
    } catch (loadError) {
      console.error('Failed to load usage limits:', loadError);
      setError(t('usage.loadFailed'));
      setWindows(null);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const sortedWindows = useMemo(() => (windows ? sortWindows(windows) : []), [windows]);

  const lastObservedAt = useMemo(() => {
    if (sortedWindows.length === 0) return null;
    const newest = sortedWindows.reduce(
      (latest, current) => (current.observedAt > latest ? current.observedAt : latest),
      sortedWindows[0].observedAt,
    );
    return formatResetTime(newest, i18n.language);
  }, [sortedWindows, i18n.language]);

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

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {!error && !isLoading && sortedWindows.length === 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground">{t('usage.empty.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('usage.empty.description')}</p>
        </div>
      )}

      {sortedWindows.length > 0 && (
        <div className="space-y-5 rounded-lg border border-border p-4">
          {sortedWindows.map((usageWindow) => (
            <UsageBar key={usageWindow.type} window={usageWindow} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {lastObservedAt
          ? `${t('usage.disclaimer')} · ${t('usage.lastUpdated', { time: lastObservedAt })}`
          : t('usage.disclaimer')}
      </p>
    </div>
  );
}
