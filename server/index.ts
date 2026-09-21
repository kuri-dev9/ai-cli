#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
// 같은 이유로 여기 있어야 한다 — import 는 호이스팅되므로, 본문에 적으면 아래
// 모듈들이 먼저 평가된 뒤에야 설정된다.
import './configure-network.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { AppError, findApplicationRoot, getModuleDirectory, IS_PLATFORM, terminalTextStyles } from '@/shared/utils.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerRuntimeService,
} from '@/modules/providers/index.js';
import { createWebSocketServer, initializeRunStateBroadcast } from '@/modules/websocket/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { HttpsConfigError, isHttpsEnabled, loadHttpsCredentials } from './shared/https-config.js';
import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes } from './modules/user/index.js';
import {
    getPluginPort,
    pluginsRoutes,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { voiceRoutes } from './modules/voice/index.js';
import {
    closeScheduledMessageDispatcher,
    initializeScheduledMessageDispatcher,
    scheduledMessagesRoutes,
} from './modules/scheduled-messages/index.js';
import { closeTelegramBridge, initializeTelegramBridge, telegramRoutes } from './modules/telegram-bridge/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { initializeDatabase, sessionsDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    isPlatform: IS_PLATFORM,
});
console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();

/**
 * 기본은 HTTP 다. `.env` 의 HTTPS_ENABLED=true 일 때만 TLS 로 뜬다.
 * TLS 를 켜 놓고 인증서를 못 읽으면 평문으로 폴백하지 않고 즉시 멈춘다 —
 * 암호화됐다고 믿는 채로 평문으로 도는 것이 가장 나쁜 실패다.
 */
function createAppServer() {
    if (!isHttpsEnabled()) {
        return { server: http.createServer(app), protocol: 'http' as const };
    }

    try {
        const credentials = loadHttpsCredentials(APP_ROOT);
        console.log(`${terminalTextStyles.info('[INFO]')} HTTPS enabled`);
        console.log(`${terminalTextStyles.info('[INFO]')}   key:  ${terminalTextStyles.dim(credentials.keyPath)}`);
        console.log(`${terminalTextStyles.info('[INFO]')}   cert: ${terminalTextStyles.dim(credentials.certPath)}`);
        return {
            server: https.createServer({ key: credentials.key, cert: credentials.cert }, app),
            protocol: 'https' as const,
        };
    } catch (error) {
        if (error instanceof HttpsConfigError) {
            console.error('');
            console.error(`${terminalTextStyles.error('[ERROR]')} ${error.message}`);
            console.error('');
        } else {
            console.error(`${terminalTextStyles.error('[ERROR]')} HTTPS 인증서를 불러오지 못했습니다:`, error);
        }
        process.exit(1);
    }
}

const { server, protocol: SERVER_PROTOCOL } = createAppServer();
const queryClaude = providerRuntimeService.getRunner('claude');
const queryCursor = providerRuntimeService.getRunner('cursor');
const queryCodex = providerRuntimeService.getRunner('codex');
const queryOpenCode = providerRuntimeService.getRunner('opencode');
const gitRoutes = createGitModule({
    queryClaude,
    queryCursor,
});
const agentRoutes = createAgentModule({
    queryClaude,
    queryCursor,
    queryCodex,
    queryOpenCode,
});

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        runtime: providerRuntimeService,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
    },
    getPluginPort,
});

app.use(cors({ exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// File Tree API Routes (protected)
app.use('/api/file-tree', authenticateToken, fileTreeRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Git worktree management (protected)
app.use('/api/worktrees', authenticateToken, worktreesRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

app.use('/api/system', authenticateToken, systemRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/scheduled-messages', authenticateToken, scheduledMessagesRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

app.use('/api/voice', authenticateToken, voiceRoutes);

// Telegram Bridge API Routes (protected)
app.use('/api/telegram', authenticateToken, telegramRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the global ~/.cloudcli/assets folder.

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `${SERVER_PROTOCOL}://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to ${SERVER_PROTOCOL}://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to ${SERVER_PROTOCOL}://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('CloudCLI Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright(SERVER_PROTOCOL + '://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
            // Sends anything that came due while the server was not running,
            // then keeps polling.
            initializeScheduledMessageDispatcher(providerRuntimeService);
            // 설정이 있을 때만 켜진다. 텔레그램 쪽으로 나가는 연결만 쓰므로
            // 인바운드 포트는 열지 않는다.
            initializeTelegramBridge(providerRuntimeService);
            // 브라우저 밖에서 시작된 턴(텔레그램·예약 메시지)도 열려 있는
            // 화면에 "돌고 있음"이 보이게 한다.
            initializeRunStateBroadcast();

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            // 이 두 줄은 종료 핸들러 바깥에 있어서 서버가 뜨자마자 실행됐다.
            // 그 시점에는 감시자도 디스패처도 아직 시작 전이라 아무 일도 하지
            // 않았고, 정작 종료할 때는 둘 다 정리되지 않은 채로 남았다.
            await closeSessionsWatcher();
            closeScheduledMessageDispatcher();
            closeTelegramBridge();
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
