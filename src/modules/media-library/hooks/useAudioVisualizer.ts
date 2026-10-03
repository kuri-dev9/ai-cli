import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * 재생 중인 소리를 막대로 그린다.
 *
 * 곡 전체의 모양이 아니라 "지금 나오는 소리"다. 전체 파형을 그리려면 파일을
 * 끝까지 받아 디코드해야 하는데, 그러면 스트리밍으로 얻은 이득이 사라진다.
 * 여기서는 이미 흐르고 있는 소리만 들여다보므로 추가 전송이 없다.
 */

/** 브라우저가 창당 허용하는 오디오 컨텍스트 수가 많지 않아 하나를 같이 쓴다. */
let sharedContext: AudioContext | null = null;

/**
 * 한 엘리먼트에 `createMediaElementSource` 는 한 번만 쓸 수 있다. 두 번째
 * 호출은 예외이므로 만들어 둔 분석기를 엘리먼트에 매달아 두고 다시 쓴다.
 */
const analysers = new WeakMap<HTMLMediaElement, AnalyserNode>();

function getAnalyser(media: HTMLMediaElement): AnalyserNode | null {
  const existing = analysers.get(media);
  if (existing) {
    return existing;
  }

  const AudioContextClass = window.AudioContext
    ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }

  try {
    sharedContext = sharedContext ?? new AudioContextClass();
    const analyser = sharedContext.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    // 소리는 분석기를 지나 스피커로 간다. 이 연결을 끊으면 재생이 멎으므로
    // 엘리먼트가 살아 있는 동안은 그대로 둔다.
    sharedContext.createMediaElementSource(media).connect(analyser);
    analyser.connect(sharedContext.destination);
    analysers.set(media, analyser);
    return analyser;
  } catch {
    // 오디오 그래프를 못 만들면 그림만 포기한다. 재생은 그대로다.
    return null;
  }
}

/** 캔버스를 비운다. 멈췄을 때 마지막 프레임이 얼어붙어 있지 않도록. */
function clearCanvas(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

export function useAudioVisualizer(
  mediaRef: RefObject<HTMLMediaElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const media = mediaRef.current;
    const canvas = canvasRef.current;
    if (!enabled || !media || !canvas) {
      return undefined;
    }

    let analyser: AnalyserNode | null = null;
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const context = canvas.getContext('2d');
      if (!analyser || !context) {
        return;
      }

      // 화면 배율을 따라가야 막대가 뭉개지지 않는다.
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * ratio);
      const height = Math.round(canvas.clientHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const bins = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins);

      context.clearRect(0, 0, width, height);
      context.fillStyle = window.getComputedStyle(canvas).color;

      const gap = Math.max(1, Math.round(ratio));
      const barWidth = Math.max(1, width / bins.length - gap);
      for (let index = 0; index < bins.length; index += 1) {
        // 바닥에 1px 을 남겨 두어 조용할 때도 선이 보인다.
        const barHeight = Math.max(ratio, (bins[index] / 255) * height);
        context.fillRect(
          index * (barWidth + gap),
          height - barHeight,
          barWidth,
          barHeight,
        );
      }
    };

    const start = () => {
      analyser = analyser ?? getAnalyser(media);
      if (!analyser) {
        return;
      }
      // 자동 재생 정책 때문에 컨텍스트가 멈춘 채 만들어질 수 있다. 재생이
      // 시작됐다는 것은 사용자가 눌렀다는 뜻이므로 여기서 깨운다.
      void sharedContext?.resume();
      if (!frame) {
        frame = requestAnimationFrame(draw);
      }
    };

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      clearCanvas(canvas);
    };

    media.addEventListener('play', start);
    media.addEventListener('pause', stop);
    media.addEventListener('ended', stop);
    if (!media.paused) {
      start();
    }

    return () => {
      media.removeEventListener('play', start);
      media.removeEventListener('pause', stop);
      media.removeEventListener('ended', stop);
      cancelAnimationFrame(frame);
    };
  }, [mediaRef, canvasRef, enabled]);
}
