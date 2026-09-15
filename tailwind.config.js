/**
 * 글꼴 CSS 변수가 아직 없을 때 쓰는 시스템 폴백.
 * src/shared/fontSettings.ts 의 같은 이름 상수와 짝이다 — 한쪽만 고치지 말 것.
 */
const SYSTEM_SANS_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", "Malgun Gothic", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif';
const SYSTEM_SERIF_FALLBACK =
  'Georgia, Cambria, "Apple SD Gothic Neo", "Malgun Gothic", "Times New Roman", serif';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        // 글꼴은 설정 > 외관에서 사용자가 고른다(src/shared/fontSettings.ts). 여기서는
        // 그 결과가 담긴 CSS 변수만 가리킨다 — 변수 하나가 바뀌면 앱 전체가 즉시 바뀐다.
        // var() 의 두 번째 인자는 변수가 아직 안 붙었을 때(첫 페인트, 오프라인)의
        // 시스템 폴백이고, 한글(Apple SD Gothic Neo / Malgun Gothic)까지 포함한다.
        sans: [`var(--app-font-sans, ${SYSTEM_SANS_FALLBACK})`],
        // 제목 전용. 기본값은 "본문과 동일" 이라 아무것도 강요하지 않는다.
        heading: [`var(--app-font-heading, ${SYSTEM_SANS_FALLBACK})`],
        // 명시적으로 세리프가 필요한 곳을 위해 남겨 둔 고정 스택. 제목에는 쓰지 말 것 —
        // 컴포넌트에 글꼴을 박으면 설정이 먹지 않는다.
        serif: [`"Source Serif 4", "Noto Serif KR", ${SYSTEM_SERIF_FALLBACK}`],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      spacing: {
        'safe-area-inset-bottom': 'env(safe-area-inset-bottom)',
        'mobile-nav': 'var(--mobile-nav-total)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'dialog-overlay-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'dialog-content-show': {
          from: { opacity: '0', transform: 'translate(-50%, -48%) scale(0.96)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'bottom-sheet-content-show': {
          from: { opacity: '0', transform: 'translateY(100%)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'dialog-overlay-show': 'dialog-overlay-show 150ms ease-out',
        'dialog-content-show': 'dialog-content-show 150ms ease-out',
        'bottom-sheet-content-show': 'bottom-sheet-content-show 220ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
