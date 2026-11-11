import * as React from 'react';

import { cn } from '@/shared/utils';

type SliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 손잡이 옆에 보일 값. 0 을 "끔" 처럼 따로 부르고 싶을 때 쓴다. */
  formatValue?: (value: number) => string;
  /** 슬라이더 아래의 한 줄 설명. */
  hint?: string;
  disabled?: boolean;
  /**
   * 끌기를 놓았을 때(또는 키보드로 옮긴 뒤) 한 번만 부른다. 끄는 동안 값마다
   * 저장하면 요청이 수십 번 나가고, 중간값이 잠깐씩 서버에 적힌다.
   */
  onCommit: (value: number) => void;
  className?: string;
};

/** 숫자 하나를 범위 안에서 고르는 막대. 채팅 세션 설정과 룸 설정이 쓴다. */
export function Slider({ label, value, min, max, step = 1, formatValue, hint, disabled, onCommit, className }: SliderProps) {
  const id = React.useId();
  // 끄는 중인 값. null 이면 저장된 값을 보여 준다.
  const [draft, setDraft] = React.useState<number | null>(null);
  const shown = draft ?? value;

  const commit = () => {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next !== value) {
      onCommit(next);
    }
  };

  const percent = max > min ? ((shown - min) / (max - min)) * 100 : 0;

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <label htmlFor={id} className="font-medium text-foreground">{label}</label>
        <span className="tabular-nums text-muted-foreground">{formatValue ? formatValue(shown) : shown}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        style={{ background: `linear-gradient(to right, hsl(var(--primary)) ${percent}%, hsl(var(--muted)) ${percent}%)` }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-primary disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
