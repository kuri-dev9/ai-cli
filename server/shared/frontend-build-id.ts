import fs from 'fs';

/**
 * 지금 `dist/` 가 내보내고 있는 프론트엔드 번들의 식별자를 읽는다.
 *
 * 값은 vite 가 `index.html` 에 심어 둔 엔트리 스크립트의 파일명이다. 내용
 * 해시를 담은 이름이라 빌드 하나를 정확히 가리키고, 브라우저도 같은 문서에서
 * 같은 태그를 읽을 수 있다 — 서버와 탭이 같은 것을 보게 하려고 이 값을 골랐다.
 *
 * 쓰임새는 하나다. 열어 둔 탭이 `/health` 로 이 값을 받아 자기가 돌리고 있는
 * 번들과 견주고, 다르면 스스로 새로고침한다. 다시 빌드해 놓고도 예전 코드를
 * 보며 "분명 고쳤는데"를 반복하는 일을 없애기 위한 것이다.
 */

/** `<script type="module" src="...">` 에서 파일명만 뽑는다. 못 찾으면 null. */
export function parseFrontendBuildId(html: string): string | null {
    // 속성 순서를 가정하지 않는다. vite 는 `type` 다음에 `crossorigin` 을 넣고
    // 그 뒤에 `src` 를 두지만, 그 배치에 기대야 할 이유가 없다.
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
        if (!/\btype\s*=\s*"module"/.test(tag)) continue;
        const src = tag.match(/\bsrc\s*=\s*"([^"]+)"/);
        if (!src) continue;
        return src[1].split('/').pop() || null;
    }
    return null;
}

/**
 * `index.html` 을 읽어 빌드 식별자를 돌려준다.
 *
 * 프로세스 시작 시 한 번만 읽어서는 안 된다. express.static 은 요청이 올
 * 때마다 디스크를 보므로, 서버를 켜 둔 채 다시 빌드하면 내보내는 것은 이미 새
 * 번들이다. 그렇다고 요청마다 파싱할 이유도 없어서, mtime 과 크기가 그대로면
 * 지난번 값을 그대로 돌려준다.
 */
export function createFrontendBuildIdReader(indexHtmlPath: string): () => string | null {
    let cache: { mtimeMs: number; size: number; id: string | null } | null = null;

    return () => {
        let stats: fs.Stats;
        try {
            stats = fs.statSync(indexHtmlPath);
        } catch {
            // 아직 빌드하지 않았다. 비교할 것이 없으면 탭은 아무것도 하지 않는다.
            return null;
        }

        if (cache && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) {
            return cache.id;
        }

        let id: string | null = null;
        try {
            id = parseFrontendBuildId(fs.readFileSync(indexHtmlPath, 'utf8'));
        } catch {
            id = null;
        }

        cache = { mtimeMs: stats.mtimeMs, size: stats.size, id };
        return id;
    };
}
