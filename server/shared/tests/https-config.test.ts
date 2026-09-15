import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_HTTPS_CERT_PATH,
  DEFAULT_HTTPS_KEY_PATH,
  HttpsConfigError,
  isHttpsEnabled,
  loadHttpsCredentials,
  resolveHttpsPaths,
} from '../https-config.js';

const APP_ROOT = '/app';

describe('isHttpsEnabled', () => {
  it('미설정이면 꺼진 것으로 본다 (기본값은 HTTP)', () => {
    assert.equal(isHttpsEnabled({}), false);
    assert.equal(isHttpsEnabled({ HTTPS_ENABLED: '' }), false);
    assert.equal(isHttpsEnabled({ HTTPS_ENABLED: '   ' }), false);
  });

  it("문자열 'false' 를 truthy 로 오해하지 않는다", () => {
    assert.equal(isHttpsEnabled({ HTTPS_ENABLED: 'false' }), false);
    assert.equal(isHttpsEnabled({ HTTPS_ENABLED: '0' }), false);
    assert.equal(isHttpsEnabled({ HTTPS_ENABLED: 'off' }), false);
  });

  it('명시적으로 켠 값만 허용한다', () => {
    for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
      assert.equal(isHttpsEnabled({ HTTPS_ENABLED: value }), true, value);
    }
  });

  it('알 수 없는 값은 꺼진 것으로 본다', () => {
    assert.equal(isHttpsEnabled({ HTTPS_ENABLED: 'ture' }), false);
  });
});

describe('resolveHttpsPaths', () => {
  it('설정이 없으면 앱 루트 기준 기본 경로를 쓴다', () => {
    assert.deepEqual(resolveHttpsPaths(APP_ROOT, {}), {
      keyPath: path.resolve(APP_ROOT, DEFAULT_HTTPS_KEY_PATH),
      certPath: path.resolve(APP_ROOT, DEFAULT_HTTPS_CERT_PATH),
    });
  });

  it('상대 경로는 앱 루트 기준으로 푼다', () => {
    const resolved = resolveHttpsPaths(APP_ROOT, {
      HTTPS_KEY_PATH: 'tls/my.key',
      HTTPS_CERT_PATH: 'tls/my.crt',
    });
    assert.equal(resolved.keyPath, path.resolve(APP_ROOT, 'tls/my.key'));
    assert.equal(resolved.certPath, path.resolve(APP_ROOT, 'tls/my.crt'));
  });

  it('절대 경로는 그대로 쓴다', () => {
    const resolved = resolveHttpsPaths(APP_ROOT, {
      HTTPS_KEY_PATH: '/etc/tls/my.key',
      HTTPS_CERT_PATH: '/etc/tls/my.crt',
    });
    assert.equal(resolved.keyPath, '/etc/tls/my.key');
    assert.equal(resolved.certPath, '/etc/tls/my.crt');
  });

  it('빈 문자열은 미설정과 같게 취급한다', () => {
    const resolved = resolveHttpsPaths(APP_ROOT, { HTTPS_KEY_PATH: '  ' });
    assert.equal(resolved.keyPath, path.resolve(APP_ROOT, DEFAULT_HTTPS_KEY_PATH));
  });
});

describe('loadHttpsCredentials', () => {
  it('두 파일을 모두 읽으면 내용과 경로를 함께 돌려준다', () => {
    const files = new Map([
      [path.resolve(APP_ROOT, DEFAULT_HTTPS_KEY_PATH), Buffer.from('KEY')],
      [path.resolve(APP_ROOT, DEFAULT_HTTPS_CERT_PATH), Buffer.from('CERT')],
    ]);

    const credentials = loadHttpsCredentials(APP_ROOT, {}, (filePath) => {
      const found = files.get(filePath);
      if (!found) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return found;
    });

    assert.equal(credentials.key.toString(), 'KEY');
    assert.equal(credentials.cert.toString(), 'CERT');
    assert.equal(credentials.keyPath, path.resolve(APP_ROOT, DEFAULT_HTTPS_KEY_PATH));
    assert.equal(credentials.certPath, path.resolve(APP_ROOT, DEFAULT_HTTPS_CERT_PATH));
  });

  it('파일이 없으면 조용히 넘어가지 않고 에러를 던진다', () => {
    assert.throws(
      () =>
        loadHttpsCredentials(APP_ROOT, {}, () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }),
      (error: unknown) => {
        assert.ok(error instanceof HttpsConfigError);
        assert.match(error.message, /파일이 없습니다/);
        // 사용자가 다음에 뭘 해야 하는지가 메시지에 들어 있어야 한다.
        assert.match(error.message, /generate-cert\.sh/);
        assert.match(error.message, /HTTPS_ENABLED=false/);
        return true;
      }
    );
  });

  it('두 파일 모두 문제면 둘 다 보고한다', () => {
    try {
      loadHttpsCredentials(APP_ROOT, {}, () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
      assert.fail('에러가 나야 한다');
    } catch (error) {
      assert.ok(error instanceof HttpsConfigError);
      assert.match(error.message, /개인키\(HTTPS_KEY_PATH\)/);
      assert.match(error.message, /인증서\(HTTPS_CERT_PATH\)/);
      assert.match(error.message, /읽을 권한이 없습니다/);
    }
  });

  it('키만 읽히고 인증서가 없으면 인증서 쪽만 보고한다', () => {
    const keyPath = path.resolve(APP_ROOT, DEFAULT_HTTPS_KEY_PATH);
    try {
      loadHttpsCredentials(APP_ROOT, {}, (filePath) => {
        if (filePath === keyPath) return Buffer.from('KEY');
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });
      assert.fail('에러가 나야 한다');
    } catch (error) {
      assert.ok(error instanceof HttpsConfigError);
      assert.doesNotMatch(error.message, /개인키\(HTTPS_KEY_PATH\)/);
      assert.match(error.message, /인증서\(HTTPS_CERT_PATH\)/);
    }
  });
});
