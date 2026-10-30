import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createFrontendBuildIdReader, parseFrontendBuildId } from '../frontend-build-id.js';

/** vite 가 실제로 내보내는 모양. 이것을 못 읽으면 자동 새로고침이 조용히 멎는다. */
const VITE_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script type="module" crossorigin src="/assets/index-DHt55R5V.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-2TeLpziq.js">
    <link rel="stylesheet" crossorigin href="/assets/index-CKJjTgPb.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

describe('parseFrontendBuildId', () => {
  it('vite 가 심은 엔트리 스크립트의 파일명을 읽는다', () => {
    assert.equal(parseFrontendBuildId(VITE_INDEX_HTML), 'index-DHt55R5V.js');
  });

  it('modulepreload 는 번들을 가리켜도 엔트리가 아니므로 고르지 않는다', () => {
    // `<link rel="modulepreload">` 가 먼저 와도 결과는 같아야 한다.
    const reordered = `<link rel="modulepreload" crossorigin href="/assets/vendor-react-2TeLpziq.js">
      <script type="module" crossorigin src="/assets/index-DHt55R5V.js"></script>`;
    assert.equal(parseFrontendBuildId(reordered), 'index-DHt55R5V.js');
  });

  it('속성 순서가 바뀌어도 읽는다', () => {
    const swapped = '<script src="/assets/index-ABC123.js" type="module" crossorigin></script>';
    assert.equal(parseFrontendBuildId(swapped), 'index-ABC123.js');
  });

  it('src 없는 인라인 module 스크립트는 건너뛴다', () => {
    const withInline = `<script type="module">console.log('inline')</script>
      <script type="module" crossorigin src="/assets/index-XYZ789.js"></script>`;
    assert.equal(parseFrontendBuildId(withInline), 'index-XYZ789.js');
  });

  it('module 이 아닌 스크립트만 있으면 null — 모르는 것을 근거로 새로고침시키지 않는다', () => {
    assert.equal(parseFrontendBuildId('<script src="/legacy.js"></script>'), null);
    assert.equal(parseFrontendBuildId('<html><body></body></html>'), null);
  });
});

describe('createFrontendBuildIdReader', () => {
  it('빌드 전에는 null 을 준다', () => {
    const read = createFrontendBuildIdReader(path.join(os.tmpdir(), 'cloudcli-does-not-exist.html'));
    assert.equal(read(), null);
  });

  it('서버를 켜 둔 채 다시 빌드하면 새 값을 집어낸다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-build-id-'));
    const indexPath = path.join(dir, 'index.html');

    try {
      fs.writeFileSync(indexPath, VITE_INDEX_HTML, 'utf8');
      const read = createFrontendBuildIdReader(indexPath);
      assert.equal(read(), 'index-DHt55R5V.js');
      // 캐시를 타는 두 번째 호출도 같은 값이어야 한다.
      assert.equal(read(), 'index-DHt55R5V.js');

      // 새 빌드. mtime 해상도가 낮은 파일시스템에서도 크기가 달라 감지된다.
      fs.writeFileSync(
        indexPath,
        VITE_INDEX_HTML.replace('index-DHt55R5V.js', 'index-NEWHASH00.js'),
        'utf8',
      );
      assert.equal(read(), 'index-NEWHASH00.js');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
