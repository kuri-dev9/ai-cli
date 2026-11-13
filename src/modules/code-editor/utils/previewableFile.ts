import type { PreviewKind } from '@/shared/types';

// Some binary files can't be edited as text, but the browser can still render
// them natively (images, PDFs, audio, video). For those we show an inline
// preview instead of the generic "binary file" placeholder. Anything not listed
// here (zip, exe, avi, mkv, fonts, ...) falls through to the binary message.


// Single source of truth: every extension the browser can preview, mapped to the
// MIME type we apply when the server response has a missing/generic Content-Type.
// The preview kind is derived from the MIME type so the two never drift apart.
// Formats browsers generally can't play (avi, mkv, flv, wmv) are intentionally
// absent and keep the binary fallback.
const EXTENSION_MIME: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  apng: 'image/apng',
  // PDF
  pdf: 'application/pdf',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  weba: 'audio/webm',
};

const extensionOf = (filename: string): string => filename.split('.').pop()?.toLowerCase() ?? '';

const kindForMime = (mime: string): PreviewKind | null => {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
};

export const getPreviewKind = (filename: string): PreviewKind | null => {
  const mime = EXTENSION_MIME[extensionOf(filename)];
  return mime ? kindForMime(mime) : null;
};

// MIME type to fall back to when the server returns no/generic Content-Type.
// Returns undefined for non-previewable extensions.
export const getPreviewMimeType = (filename: string): string | undefined =>
  EXTENSION_MIME[extensionOf(filename)];

// 채팅에서 "보기" 단추를 붙여 오른쪽에 읽기용으로 여는 문서 형식.
// 마크다운·HTML 은 렌더링해서, 나머지는 글자 그대로, PDF 는 미리보기로 보여 준다.
const DOCUMENT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'html', 'htm', 'txt', 'rst', 'adoc', 'csv', 'tsv', 'pdf',
]);

export const isDocumentFile = (filename: string): boolean => {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.includes('.') && DOCUMENT_EXTENSIONS.has(extensionOf(base));
};

// 문서 말고도 채팅에서 "보기" 단추를 붙이는 소스·설정 파일 형식.
// `api.renameProject`, `process.env` 처럼 점이 든 코드 이름과 헷갈리지 않도록
// 아는 확장자만 받는다.
const SOURCE_EXTENSIONS = new Set([
  'gs', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'swift', 'dart',
  'c', 'cc', 'cpp', 'hpp', 'cs', 'm', 'lua', 'pl', 'r',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql',
  'css', 'scss', 'sass', 'less',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'gradle', 'properties',
]);

// 확장자가 없어도 그 자체로 파일 이름인 것들.
const SOURCE_FILENAMES = new Set(['Dockerfile', 'Makefile', 'Jenkinsfile', 'Procfile']);

/** 채팅에서 "보기" 단추를 붙일 파일인가. 문서 형식이거나 아는 소스·설정 파일이다. */
export const isViewableFile = (filename: string): boolean => {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  if (SOURCE_FILENAMES.has(base)) {
    return true;
  }
  return isDocumentFile(base) || (base.includes('.') && SOURCE_EXTENSIONS.has(extensionOf(base)));
};
