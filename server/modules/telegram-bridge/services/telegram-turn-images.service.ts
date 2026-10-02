import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  resolveImageAbsolutePath,
} from '@/shared/image-attachments.js';
import type { NormalizedMessage } from '@/shared/types.js';
import type { TelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';

/**
 * 한 턴에서 AI 가 만든 이미지를 골라 텔레그램으로 보낸다.
 *
 * 이미지만 보낸다. 코드·문서까지 보내면 AI 가 소스를 고칠 때마다 파일이
 * 쏟아지고, 텔레그램에서 서버의 파일을 꺼내 가는 통로가 된다. 보내는 대상도
 * 이 턴의 실행 기록이 "만들었다"고 말하는 파일로만 한정한다 — 폴더를 뒤져서
 * 찾지 않는다.
 *
 * 기록이 말해 주는 것은 두 가지다.
 * - Codex `image_gen` 이 그린 그림: 실행이 응답 이벤트의 `images` 에 싣는다.
 * - 파일 쓰기 도구로 만든 파일: Claude `Write`, Codex `file_change`(추가)는
 *   모두 `tool_use` / `Write` / `toolInput.file_path` 로 정규화된다.
 *
 * 스크립트를 돌려 저장한 그림(파이썬 차트 등)은 기록에 경로가 남지 않아서
 * 여기서 잡지 못한다.
 */

/** 한 턴에 보낼 최대 장수. 넘는 것은 보내지 않고 몇 장 남았는지만 알린다. */
const MAX_IMAGES_PER_TURN = 10;

/** `sendPhoto` 의 한도. 넘으면 파일로 보낸다. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** `sendDocument` 의 한도. 넘으면 보내지 않는다. */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * 파일 시각은 초 단위로 잘리는 파일 시스템도 있어서, 실행 시작 직후에 쓴
 * 파일이 시작보다 조금 이르게 찍힐 수 있다. 그만큼만 봐준다.
 */
const MTIME_TOLERANCE_MS = 2_000;

/** 실행 기록에서 뽑아 둔 후보. 기록은 다음 실행이 곧 덮으므로 바로 떠 둔다. */
type TurnImageCandidates = {
  paths: string[];
  startedAt: number;
};

/** 텔레그램으로 보낼 이미지 하나. */
type TurnImage = {
  path: string;
  name: string;
  size: number;
};

/**
 * 끝난 실행의 기록에서 이미지 후보 경로를 뽑는다.
 *
 * 브리지가 `onRunSettled` 안에서 *동기로* 부른다. 대기열에 다음 메시지가 있으면
 * 몇 밀리초 안에 새 실행이 같은 세션 자리를 차지하고, 그 뒤에 기록을 읽으면
 * 다른 턴의 것을 보게 된다.
 */
export function readTurnImageCandidates(sessionId: string): TurnImageCandidates | null {
  const run = chatRunRegistry.getRun(sessionId);
  if (!run) {
    return null;
  }

  const projectPath = sessionsDb.getSessionById(sessionId)?.project_path ?? undefined;
  const events = chatRunRegistry.replayEvents(sessionId, 0) as NormalizedMessage[];
  const paths: string[] = [];

  for (const event of events) {
    // 사용자 메시지에 붙은 첨부(텔레그램에서 보낸 사진 포함)는 되돌려 보내지 않는다.
    if (event.role === 'assistant' && event.images) {
      for (const descriptor of normalizeAttachmentDescriptors(event.images)) {
        paths.push(resolveImageAbsolutePath(projectPath, descriptor.path));
      }
    }

    if (event.kind === 'tool_use' && event.toolName === 'Write') {
      const filePath = (event.toolInput as { file_path?: unknown } | undefined)?.file_path;
      if (typeof filePath === 'string' && filePath.trim()) {
        paths.push(resolveImageAbsolutePath(projectPath, filePath.trim()));
      }
    }
  }

  const uniqueImagePaths = [...new Set(paths)].filter(
    (candidate) => isImageAttachmentDescriptor({ path: candidate }),
  );
  return { paths: uniqueImagePaths, startedAt: run.startedAt };
}

/**
 * 확장자가 아니라 내용으로 이미지인지 본다.
 *
 * `Write` 는 글자만 쓸 수 있어서 `chart.png` 라는 이름에 SVG 나 base64 글이
 * 들어 있기도 하다. 그런 파일을 사진으로 보내면 텔레그램이 거절하고, 파일로
 * 보내면 깨진 그림이 간다.
 */
function hasImageSignature(header: Buffer): boolean {
  const isPng = header.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isGif = header.subarray(0, 4).toString('latin1') === 'GIF8';
  const isWebp = header.subarray(0, 4).toString('latin1') === 'RIFF'
    && header.subarray(8, 12).toString('latin1') === 'WEBP';
  return isPng || isJpeg || isGif || isWebp;
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 후보 가운데 실제로 보낼 것만 남긴다.
 *
 * 이 턴이 시작된 뒤에 쓰인, 내용이 진짜 이미지인 파일만 통과한다. 기록에
 * 경로가 남았어도 쓰기가 실패했거나 예전 파일을 다시 가리키는 경우가 있다.
 */
async function loadTurnImages(
  candidates: TurnImageCandidates,
): Promise<{ images: TurnImage[]; overflow: number }> {
  const images: TurnImage[] = [];

  for (const candidate of candidates.paths) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_DOCUMENT_BYTES) {
        continue;
      }
      if (stats.mtimeMs < candidates.startedAt - MTIME_TOLERANCE_MS) {
        continue;
      }
      if (!hasImageSignature(await readHeader(candidate))) {
        continue;
      }
      images.push({ path: candidate, name: path.basename(candidate), size: stats.size });
    } catch {
      // 지워졌거나 읽을 수 없는 파일은 보낼 것이 아니다.
    }
  }

  return {
    images: images.slice(0, MAX_IMAGES_PER_TURN),
    overflow: Math.max(0, images.length - MAX_IMAGES_PER_TURN),
  };
}

/**
 * 한 장을 한 대화에 보낸다. 사진으로 먼저 시도하고, 거절되면 파일로 보낸다.
 *
 * 사진은 텔레그램이 크기·비율 제한을 걸고 다시 압축한다. 아주 길쭉한 화면
 * 캡처처럼 사진으로 안 되는 것도 파일로는 간다.
 */
async function sendImage(client: TelegramClient, chatId: number, image: TurnImage, content: Buffer) {
  if (image.size <= MAX_PHOTO_BYTES) {
    try {
      await client.sendPhoto(chatId, content, image.name);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn('[TelegramBridge] Photo upload refused; sending as a file', { chatId, error: reason });
    }
  }
  await client.sendDocument(chatId, content, image.name);
}

/**
 * 이 턴에 만든 이미지를 모든 허용된 대화에 보낸다.
 *
 * 브리지가 완료 메시지를 보낸 뒤에 부른다. 한 장이 실패해도 나머지는 보낸다.
 * 보낼 이미지가 없으면 아무것도 하지 않는다.
 */
export async function relayTurnImages(
  client: TelegramClient,
  chatIds: readonly number[],
  candidates: TurnImageCandidates,
): Promise<void> {
  const { images, overflow } = await loadTurnImages(candidates);
  if (images.length === 0) {
    return;
  }

  for (const image of images) {
    let content: Buffer;
    try {
      content = await fs.readFile(image.path);
    } catch {
      continue;
    }

    for (const chatId of chatIds) {
      try {
        await sendImage(client, chatId, image, content);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error('[TelegramBridge] Failed to send an image', { chatId, image: image.name, error: reason });
      }
    }
  }

  if (overflow > 0) {
    for (const chatId of chatIds) {
      await client.sendMessage(chatId, `🖼 이미지 ${overflow}장은 더 있어 보내지 않았습니다. 웹에서 확인해 주세요.`)
        .catch(() => {});
    }
  }
}
