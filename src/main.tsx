import React from 'react'
import ReactDOM from 'react-dom/client'
import { scan } from 'react-scan'

import App from '@/App'
import { startFontSettingsSync } from '@/shared/fontSettings'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
scan({ enabled: import.meta.env.DEV && localStorage.getItem('react-scan') === 'on' })

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// 저장된 글꼴을 첫 렌더 전에 문서에 입히고, 이후 설정 변경도 계속 따라가게 한다.
// 설정 저장소가 쓴 즉시 동기로 통지하므로 새로고침 없이 반영된다.
startFontSettingsSync()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
