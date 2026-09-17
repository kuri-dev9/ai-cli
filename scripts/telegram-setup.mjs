#!/usr/bin/env node
/**
 * 텔레그램 브리지 연결을 도와주는 스크립트.
 *
 * chat_id 는 사람이 눈으로 찾기 번거롭다 — 브라우저에서 getUpdates 를 열면
 * 토큰이 주소창과 방문 기록에 그대로 남고, JSON 속에서 숫자를 골라내야 한다.
 * 그 두 가지를 대신한다. 토큰은 읽기만 하고 절대 출력하지 않는다.
 *
 *   node scripts/telegram-setup.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(projectRoot, '.env');

/** `.env` 를 줄 단위로 다룬다. 주석과 순서를 그대로 보존하기 위해서다. */
function readEnvLines() {
  if (!fs.existsSync(envPath)) {
    return [];
  }
  return fs.readFileSync(envPath, 'utf8').split('\n');
}

function readEnvValue(lines, key) {
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`));
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function writeEnvValue(lines, key, value) {
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index >= 0) {
    const next = [...lines];
    next[index] = `${key}=${value}`;
    return next;
  }
  return [...lines, `${key}=${value}`];
}

async function callTelegram(token, method) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  const body = await response.json();
  if (!body.ok) {
    throw new Error(`${method} 실패: ${body.description ?? response.status}`);
  }
  return body.result;
}

async function main() {
  const lines = readEnvLines();
  const token = readEnvValue(lines, 'TELEGRAM_BOT_TOKEN');

  if (!token) {
    console.error([
      '.env 에 TELEGRAM_BOT_TOKEN 이 없습니다.',
      '',
      '1. 텔레그램에서 @BotFather 를 찾아 /newbot 을 보냅니다.',
      '2. 이름과 username 을 정하면 토큰을 줍니다.',
      '3. 그 토큰을 .env 에 적어 주세요:',
      '',
      '   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...',
      '',
      '4. 그런 다음 이 스크립트를 다시 실행하세요.',
    ].join('\n'));
    process.exit(1);
  }

  let bot;
  try {
    bot = await callTelegram(token, 'getMe');
  } catch (error) {
    console.error(`토큰이 올바르지 않은 것 같습니다. (${error.message})`);
    process.exit(1);
  }

  console.log(`봇 확인: @${bot.username}`);

  const updates = await callTelegram(token, 'getUpdates');
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat;
    if (chat?.id && chat.type === 'private') {
      chats.set(chat.id, chat.username || chat.first_name || String(chat.id));
    }
  }

  if (chats.size === 0) {
    console.log([
      '',
      '아직 받은 메시지가 없습니다.',
      '',
      `텔레그램에서 @${bot.username} 을 찾아 아무 말이나 한마디 보낸 뒤,`,
      '이 스크립트를 다시 실행하세요.',
      '',
      '(서버가 켜져 있으면 브리지가 메시지를 먼저 가져가 버릴 수 있습니다.',
      ' 그럴 때는 서버를 잠시 멈추고 다시 보내 주세요.)',
    ].join('\n'));
    process.exit(0);
  }

  const chatIds = [...chats.keys()];
  console.log('\n대화를 건 사람:');
  for (const [id, name] of chats) {
    console.log(`  ${id}  (${name})`);
  }

  const existing = readEnvValue(lines, 'TELEGRAM_ALLOWED_CHAT_IDS');
  const merged = [...new Set([...existing.split(',').map((v) => v.trim()).filter(Boolean), ...chatIds.map(String)])];

  const updated = writeEnvValue(lines, 'TELEGRAM_ALLOWED_CHAT_IDS', merged.join(','));
  fs.writeFileSync(envPath, updated.join('\n'));

  console.log([
    '',
    `.env 에 기록했습니다: TELEGRAM_ALLOWED_CHAT_IDS=${merged.join(',')}`,
    '',
    '이 목록에 없는 사람은 봇에게 말을 걸어도 무시됩니다.',
    '본인 것이 아닌 id 가 섞였다면 .env 에서 직접 지워 주세요.',
    '',
    '이제 서버를 재시작하면 됩니다:  ./run.sh',
  ].join('\n'));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
