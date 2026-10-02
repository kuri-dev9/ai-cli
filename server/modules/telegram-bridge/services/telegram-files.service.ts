import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  toPosixPath,
} from '@/shared/image-attachments.js';
import type { ChatAttachmentDescriptor } from '@/shared/image-attachments.js';
import type { TelegramIncomingFile } from '@/modules/telegram-bridge/services/telegram-client.service.js';

/**
 * 텔레그램에서 받은 사진·파일을 웹 첨부와 같은 자리에 내려놓는다.
 *
 * 저장 위치가 `~/.cloudcli/assets` 바로 아래여야 하는 이유는 하나다 — 실행
 * 직전에 웹소켓 쪽이 첨부 경로를 다시 검사하는데(`filterAttachmentsToUploadStore`),
 * 그 폴더 바로 아래가 아닌 경로는 조용히 버린다. 같은 자리에 두면 웹에서
 * 올린 첨부와 똑같이 취급되고, 대화 기록 화면에서도 같은 경로로 보인다.
 *
 * 한도는 웹 업로드와 맞춘다. 같은 대화에 같은 파일을 어느 쪽에서 올리느냐에
 * 따라 되고 안 되고가 갈리면 안 된다.
 */

/** 한 턴에 붙일 수 있는 개수. 사진이나 화면 캡처 몇 장이면 충분하다. */
const MAX_TELEGRAM_FILES_PER_TURN = 10;

/** 웹 이미지 업로드와 같다. 모델이 받는 이미지 한 장의 한도이기도 하다. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 웹 일반 첨부 업로드와 같다. 봇 API 의 내려받기 한도(20MB)보다 작다. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 한 파일을 받는 데 이보다 오래 걸리면 포기한다. 폴링 전체가 묶이면 안 된다. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** 사람이 읽는 크기. 한도 안내에만 쓴다. */
function formatMegabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

function isImageFile(file: TelegramIncomingFile): boolean {
  return isImageAttachmentDescriptor({ path: file.name, mimeType: file.mimeType });
}

/**
 * 이 파일이 넘을 수 없는 크기와, 넘었을 때 돌려줄 안내.
 *
 * "파일로 보내기" 로 온 큰 사진은 일반 사진으로 다시 보내면 텔레그램이 줄여
 * 준다. 그 길을 알려 주는 편이 그냥 거절하는 것보다 낫다.
 */
function describeSizeLimit(file: TelegramIncomingFile): { limit: number; hint: string } {
  if (isImageFile(file)) {
    return {
      limit: MAX_IMAGE_BYTES,
      hint: file.kind === 'document'
        ? ` 사진은 ${formatMegabytes(MAX_IMAGE_BYTES)}까지입니다. 파일 대신 사진으로 보내면 텔레그램이 줄여서 보냅니다.`
        : ` 사진은 ${formatMegabytes(MAX_IMAGE_BYTES)}까지입니다.`,
    };
  }
  return { limit: MAX_FILE_BYTES, hint: ` 파일은 ${formatMegabytes(MAX_FILE_BYTES)}까지입니다.` };
}

function assertWithinSizeLimit(file: TelegramIncomingFile, size: number): void {
  const { limit, hint } = describeSizeLimit(file);
  if (size > limit) {
    throw new Error(`${file.name} (${formatMegabytes(size)}) 이(가) 너무 큽니다.${hint}`);
  }
}

/** 웹 업로드(multer)와 같은 이름 규칙. 디스크 이름은 겹치지 않게만 한다. */
function buildStoredFilename(originalName: string): string {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${uniqueSuffix}-${sanitizedName}`;
}

/**
 * 받아서 저장하고, 실행에 넘길 첨부 목록을 돌려준다.
 *
 * 텔레그램 명령 처리(`telegram-commands.service`)가 프롬프트를 보내기 직전에
 * 부른다. 하나라도 실패하면 이미 저장한 것까지 지우고 예외를 던진다 — 일부만
 * 붙은 채로 턴을 시작하면 사용자는 무엇이 빠졌는지 모른 채 답을 받는다.
 * 예외 문구는 그대로 사용자에게 보여 줄 수 있게 쓴다.
 */
export async function storeTelegramFiles(
  files: TelegramIncomingFile[],
  downloadFile: (fileId: string, signal?: AbortSignal) => Promise<Buffer>,
): Promise<ChatAttachmentDescriptor[]> {
  if (files.length > MAX_TELEGRAM_FILES_PER_TURN) {
    throw new Error(
      `한 번에 ${MAX_TELEGRAM_FILES_PER_TURN}개까지 보낼 수 있습니다. 지금 ${files.length}개입니다.`,
    );
  }

  // 받기 전에 걸러 낸다. 텔레그램이 크기를 알려 주면 내려받을 필요도 없다.
  for (const file of files) {
    if (file.size !== null) {
      assertWithinSizeLimit(file, file.size);
    }
  }

  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });

  const stored: ChatAttachmentDescriptor[] = [];
  try {
    for (const file of files) {
      const content = await downloadFile(file.fileId, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
      // 크기를 모르고 왔던 파일은 여기서 처음 잰다.
      assertWithinSizeLimit(file, content.length);

      const storedPath = path.join(assetsDir, buildStoredFilename(file.name));
      await fs.writeFile(storedPath, content, { flag: 'wx' });
      stored.push({
        path: toPosixPath(storedPath),
        name: file.name,
        mimeType: file.mimeType,
        size: content.length,
      });
    }
  } catch (error) {
    await Promise.all(stored.map((descriptor) => fs.rm(descriptor.path, { force: true })));
    throw error;
  }

  return stored;
}
