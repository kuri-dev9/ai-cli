import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// 백엔드가 HTTPS 로 뜨면 dev 서버도 같이 HTTPS 여야 한다. 한쪽만 TLS 면
// /api 프록시와 ws 프록시가 모두 끊긴다.
function resolveDevHttps(env) {
  const enabled = ['true', '1', 'yes', 'on'].includes(String(env.HTTPS_ENABLED || '').trim().toLowerCase())
  if (!enabled) return null

  const resolvePath = (configured, fallback) => {
    const candidate = String(configured || '').trim() || fallback
    return path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate)
  }

  try {
    return {
      key: fs.readFileSync(resolvePath(env.HTTPS_KEY_PATH, 'certs/server.key')),
      cert: fs.readFileSync(resolvePath(env.HTTPS_CERT_PATH, 'certs/server.crt'))
    }
  } catch (error) {
    // 백엔드는 같은 조건에서 멈추므로 여기서도 조용히 HTTP 로 넘어가지 않는다.
    throw new Error(
      `HTTPS_ENABLED=true 인데 인증서를 읽지 못했습니다: ${error.message}\n` +
      `  ./scripts/generate-cert.sh 를 실행하거나 .env 에서 HTTPS_ENABLED=false 로 두세요.`
    )
  }
}

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  const devHttps = resolveDevHttps(env)
  const httpScheme = devHttps ? 'https' : 'http'
  const wsScheme = devHttps ? 'wss' : 'ws'
  // 자체 서명 인증서는 Node 쪽 프록시에서도 신뢰되지 않으므로 검증을 끈다.
  // LAN 안의 자기 자신에게 붙는 dev 전용 경로다.
  const proxyExtras = devHttps ? { secure: false } : {}

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      ...(devHttps ? { https: devHttps } : {}),
      proxy: {
        '/api': { target: `${httpScheme}://${proxyHost}:${serverPort}`, ...proxyExtras },
        '/ws': {
          target: `${wsScheme}://${proxyHost}:${serverPort}`,
          ws: true,
          ...proxyExtras
        },
        '/shell': {
          target: `${wsScheme}://${proxyHost}:${serverPort}`,
          ws: true,
          ...proxyExtras
        },
        '/plugin-ws': {
          target: `${wsScheme}://${proxyHost}:${serverPort}`,
          ws: true,
          ...proxyExtras
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
