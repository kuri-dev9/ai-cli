/**
 * HTTPS 옵션 설정.
 *
 * 기본값은 HTTP 다. `.env` 의 `HTTPS_ENABLED=true` 로 명시적으로 켰을 때만 TLS 를 쓴다.
 * 켜 놓고 인증서를 못 읽으면 조용히 HTTP 로 떨어지지 않고 명확한 에러를 던진다.
 * TLS 를 요청했는데 평문으로 뜨는 것이 가장 위험한 실패 모드이기 때문이다.
 */
import fs from 'node:fs';
import path from 'node:path';

/** 저장소 루트 기준 기본 인증서 경로. scripts/generate-cert.sh 가 여기에 생성한다. */
export const DEFAULT_HTTPS_KEY_PATH = 'certs/server.key';
export const DEFAULT_HTTPS_CERT_PATH = 'certs/server.crt';

type EnvLike = Record<string, string | undefined>;

export type HttpsCredentials = {
  key: Buffer;
  cert: Buffer;
  keyPath: string;
  certPath: string;
};

export class HttpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpsConfigError';
  }
}

/**
 * `.env` 값은 항상 문자열이라 'false' 같은 값도 truthy 다. 그래서 켜는 값만 화이트리스트로 받는다.
 * 미설정·오타·빈 문자열은 전부 "꺼짐"으로 본다 — 기본 동작(HTTP)이 깨지지 않는 쪽이 안전하다.
 */
export function isHttpsEnabled(env: EnvLike = process.env): boolean {
  const raw = (env.HTTPS_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** 상대 경로는 앱 루트 기준으로 푼다. 절대 경로는 그대로 쓴다. */
export function resolveHttpsPaths(appRoot: string, env: EnvLike = process.env) {
  const resolveOne = (configured: string | undefined, fallback: string) => {
    const candidate = (configured ?? '').trim() || fallback;
    return path.isAbsolute(candidate) ? candidate : path.resolve(appRoot, candidate);
  };

  return {
    keyPath: resolveOne(env.HTTPS_KEY_PATH, DEFAULT_HTTPS_KEY_PATH),
    certPath: resolveOne(env.HTTPS_CERT_PATH, DEFAULT_HTTPS_CERT_PATH),
  };
}

function describeReadFailure(label: string, filePath: string, error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT') return `  - ${label} 파일이 없습니다: ${filePath}`;
  if (code === 'EACCES') return `  - ${label} 파일을 읽을 권한이 없습니다: ${filePath}`;
  const message = error instanceof Error ? error.message : String(error);
  return `  - ${label} 파일을 읽지 못했습니다: ${filePath} (${message})`;
}

/**
 * 키와 인증서를 읽어 온다. 둘 중 하나라도 실패하면 무엇이 왜 안 됐는지와
 * 고치는 방법을 함께 담아 HttpsConfigError 를 던진다.
 */
export function loadHttpsCredentials(
  appRoot: string,
  env: EnvLike = process.env,
  readFile: (filePath: string) => Buffer = (filePath) => fs.readFileSync(filePath)
): HttpsCredentials {
  const { keyPath, certPath } = resolveHttpsPaths(appRoot, env);
  const problems: string[] = [];

  let key: Buffer | null = null;
  try {
    key = readFile(keyPath);
  } catch (error) {
    problems.push(describeReadFailure('개인키(HTTPS_KEY_PATH)', keyPath, error));
  }

  let cert: Buffer | null = null;
  try {
    cert = readFile(certPath);
  } catch (error) {
    problems.push(describeReadFailure('인증서(HTTPS_CERT_PATH)', certPath, error));
  }

  if (!key || !cert) {
    throw new HttpsConfigError(
      [
        'HTTPS_ENABLED=true 인데 인증서를 읽을 수 없습니다.',
        ...problems,
        '',
        '해결 방법 중 하나를 고르세요:',
        '  1) 인증서를 만듭니다:  ./scripts/generate-cert.sh',
        '  2) .env 의 HTTPS_KEY_PATH / HTTPS_CERT_PATH 를 실제 경로로 고칩니다',
        '  3) HTTPS 를 끄고 HTTP 로 돌아갑니다:  .env 에서 HTTPS_ENABLED=false',
      ].join('\n')
    );
  }

  return { key, cert, keyPath, certPath };
}
