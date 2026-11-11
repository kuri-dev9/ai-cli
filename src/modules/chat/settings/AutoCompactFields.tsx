import { useTranslation } from 'react-i18next';

import { Slider } from '@/shared/ui';

/** 서버 상한과 같다(`server/shared/auto-compact.ts`). 넘는 값은 서버가 거절한다. */
const AUTO_COMPACT_MAX_EVERY_TURNS = 50;
const AUTO_COMPACT_MAX_TOKENS = 1_000_000;
const AUTO_COMPACT_TOKEN_STEP = 10_000;

/** 150000 → "150k", 1000000 → "1M". */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

type AutoCompactFieldsProps = {
  everyTurns: number;
  tokens: number;
  /** 토큰 기준이 0 일 때 붙일 이름. 세션은 "끔", 룸은 "기본 (맥락 60%)". */
  tokensOffLabel: string;
  disabled?: boolean;
  onChange: (changes: { everyTurns?: number; tokens?: number }) => void;
};

/**
 * 자동 대화 줄이기 기준 두 개. 둘 중 먼저 걸리는 쪽에서 다음 턴 전에 `/compact`
 * 를 돌린다. 채팅 세션 설정과 룸 설정이 함께 쓴다.
 */
export default function AutoCompactFields({ everyTurns, tokens, tokensOffLabel, disabled, onChange }: AutoCompactFieldsProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="space-y-4">
      <Slider
        label={t('autoCompact.everyTurns')}
        value={everyTurns}
        min={0}
        max={AUTO_COMPACT_MAX_EVERY_TURNS}
        step={1}
        disabled={disabled}
        formatValue={(value) => (value === 0 ? t('autoCompact.off') : t('autoCompact.everyTurnsValue', { count: value }))}
        hint={t('autoCompact.everyTurnsHint')}
        onCommit={(value) => onChange({ everyTurns: value })}
      />
      <Slider
        label={t('autoCompact.tokens')}
        value={tokens}
        min={0}
        max={AUTO_COMPACT_MAX_TOKENS}
        step={AUTO_COMPACT_TOKEN_STEP}
        disabled={disabled}
        formatValue={(value) => (value === 0 ? tokensOffLabel : t('autoCompact.tokensValue', { tokens: formatTokenCount(value) }))}
        hint={t('autoCompact.tokensHint')}
        onCommit={(value) => onChange({ tokens: value })}
      />
    </div>
  );
}
