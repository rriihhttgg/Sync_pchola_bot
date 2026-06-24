/**
 * Discord <-> Telegram bridge bot
 *
 * Discord -> Telegram: бот слушает канал и пересылает текст и медиа (фото/видео/gif/документы)
 * Telegram -> Discord: бот слушает чат и пересылает текст и медиа через Discord-вебхук,
 *                       подставляя имя и аватарку отправителя из Telegram.
 *
 * Поддержка ответов (reply):
 *   - Discord reply -> Telegram reply
 *   - Telegram reply -> Discord reply (через webhook + jump-link)
 *
 * Голос:
 *   - Telegram voice / video_note -> Discord: пересылается как файл-вложение
 *   - !sync в текстовом канале Discord: бот заходит в голосовой канал автора
 *   - Запись участников голосового канала -> Telegram voice:
 *       старт — пользователь начал говорить,
 *       конец  — 2 сек тишины, затем OGG отправляется в Telegram
 *
 * Railway-совместимо: ffmpeg берётся из пакета ffmpeg-static, нативный sodium не нужен.
 */

require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} = require('@discordjs/voice');
const { OpusEncoder } = require('@discordjs/opus');
const ffmpegPath = require('ffmpeg-static');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PORT,
  WEBHOOK_DOMAIN,
} = process.env;

// ---------- DISCORD ----------
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// ---------- TELEGRAM ----------
const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// ---------- Маппинг сообщений (reply-цепочки) ----------
const MAX_MAP_SIZE = 5000;
const discordIdToTgId = new Map(); // discordMsgId -> tgMsgId
const tgIdToDiscordId = new Map(); // tgMsgId -> discordMsgId

function registerMessageIds(discordMsgId, tgMsgId) {
  if (discordIdToTgId.size >= MAX_MAP_SIZE) {
    const firstKey = discordIdToTgId.keys().next().value;
    const firstVal = discordIdToTgId.get(firstKey);
    discordIdToTgId.delete(firstKey);
    tgIdToDiscordId.delete(firstVal);
  }
  discordIdToTgId.set(discordMsgId, tgMsgId);
  tgIdToDiscordId.set(tgMsgId, discordMsgId);
}

// ---------- Кэш аватарок Telegram-пользователей ----------
const avatarCache = new Map();
const AVATAR_TTL_MS = 30 * 60 * 1000;

async function getTelegramAvatarUrl(userId) {
  const cached = avatarCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.url;
  try {
    const photos = await tgBot.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.photos.length) {
      avatarCache.set(userId, { url: null, expires: Date.now() + AVATAR_TTL_MS });
      return null;
    }
    const fileId = photos.photos[0][0].file_id;
    const url = await tgBot.getFileLink(fileId);
    avatarCache.set(userId, { url, expires: Date.now() + AVATAR_TTL_MS });
    return url;
  } catch (err) {
    console.error('Не удалось получить аватар Telegram:', err.message);
    return null;
  }
}

// ---------- Утилиты ----------

function sanitizeWebhookUsername(name) {
  let clean = String(name)
    .replace(/discord/gi, 'disc0rd')
    .replace(/clyde/gi, 'клайд')
    .trim();
  if (!clean) clean = 'Telegram user';
  return clean.slice(0, 80);
}

function splitMessage(text, limit = 2000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks.length ? chunks : [''];
}

function fileNameFromUrl(url, fallback = 'file') {
  try {
    const base = new URL(url).pathname.split('/').pop();
    return base || fallback;
  } catch {
    return fallback;
  }
}

// ---------- Guild ID (нужен для jump-link в reply) ----------
let _guildId = null;
async function getGuildId() {
  if (_guildId) return _guildId;
  try {
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    _guildId = channel.guildId;
  } catch {
    _guildId = '@me';
  }
  return _guildId;
}

// ===== Discord Webhook =====

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Выполняет fetch с автоматическим retry при 429 (rate limit).
 * Discord возвращает retry_after в секундах.
 */
async function fetchWithRetry(url, options, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;

    let retryAfterMs = 500;
    try {
      const data = await res.clone().json();
      retryAfterMs = Math.ceil((data.retry_after ?? 0.5) * 1000) + 100;
    } catch {}

    console.warn(`Discord rate limit, ждём ${retryAfterMs}мс (попытка ${attempt + 1}/${maxRetries})`);
    await sleep(retryAfterMs);
  }
  // Последняя попытка без перехвата
  return fetch(url, options);
}

/**
 * Отправляет сообщение через Discord webhook.
 * Возвращает ID созданного сообщения (если передан webhookUrl с ?wait=true).
 */
async function sendToDiscordWebhookWithId({
  webhookUrl,
  username,
  avatarUrl,
  content,
  fileUrl,
  fileName,
  replyDiscordMsgId,
}) {
  const baseFields = {
    username: sanitizeWebhookUsername(username),
    avatar_url: avatarUrl || undefined,
    allowed_mentions: { parse: [] },
  };

  let finalContent = content || '';
  if (replyDiscordMsgId) {
    const guildId = await getGuildId();
    const jumpUrl = `https://discord.com/channels/${guildId}/${DISCORD_CHANNEL_ID}/${replyDiscordMsgId}`;
    finalContent = `↩️ [ответ на сообщение](${jumpUrl})\n` + finalContent;
  }

  if (fileUrl) {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`Не удалось скачать файл (${fileRes.status})`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const name = fileName || 'file';

    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        ...baseFields,
        content: finalContent ? finalContent.slice(0, 2000) : undefined,
        attachments: [{ id: 0, filename: name }],
      })
    );
    form.append('files[0]', new Blob([buffer]), name);

    const res = await fetchWithRetry(webhookUrl, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook вернул ${res.status}: ${body}`);
    }
    const data = await res.json().catch(() => null);
    return data?.id ?? null;
  }

  // Текстовые чанки
  const chunks = splitMessage(finalContent || '');
  let msgId = null;
  for (let i = 0; i < chunks.length; i++) {
    const url = i === 0 ? webhookUrl : DISCORD_WEBHOOK_URL;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseFields, content: chunks[i] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook вернул ${res.status}: ${body}`);
    }
    if (i === 0) {
      const data = await res.json().catch(() => null);
      msgId = data?.id ?? null;
    }
  }
  return msgId;
}

// Обёртка без wait (для совместимости со старым кодом)
async function sendToDiscordWebhook(opts) {
  return sendToDiscordWebhookWithId({ webhookUrl: DISCORD_WEBHOOK_URL, ...opts });
}

// ===== Telegram helpers =====

async function sendTelegramMessage(text, replyToTgMsgId) {
  const opts = replyToTgMsgId
    ? { reply_to_message_id: replyToTgMsgId, allow_sending_without_reply: true }
    : {};
  return tgBot.sendMessage(TELEGRAM_CHAT_ID, text, opts);
}

function getDiscordAttachmentKind(att) {
  const type = att.contentType || '';
  const name = (att.name || '').toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'animation';
  if (type.startsWith('image/') || /\.(jpe?g|png|webp)$/.test(name)) return 'photo';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'video';
  return 'document';
}

async function sendDiscordAttachmentToTelegram(att, caption, replyToTgMsgId) {
  const kind = getDiscordAttachmentKind(att);
  const opts = {
    ...(caption ? { caption } : {}),
    ...(replyToTgMsgId
      ? { reply_to_message_id: replyToTgMsgId, allow_sending_without_reply: true }
      : {}),
  };
  if (kind === 'photo') return tgBot.sendPhoto(TELEGRAM_CHAT_ID, att.url, opts);
  if (kind === 'video') return tgBot.sendVideo(TELEGRAM_CHAT_ID, att.url, opts);
  if (kind === 'animation') return tgBot.sendAnimation(TELEGRAM_CHAT_ID, att.url, opts);
  return tgBot.sendDocument(TELEGRAM_CHAT_ID, att.url, opts);
}

function buildTelegramCaption(username, content) {
  return (content ? `${username}: ${content}` : username).slice(0, 1024);
}

// ===== Discord -> Telegram (текст + вложения) =====

discordClient.on('messageCreate', async (message) => {
  if (message.channelId !== DISCORD_CHANNEL_ID) return;
  if (message.webhookId) return;
  if (message.author.bot) return;

  // Команда !sync — войти в голосовой канал
  if (message.content.trim() === '!sync') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply('Ты не находишься в голосовом канале.');
      return;
    }
    await joinAndRecord(voiceChannel, message.guild);
    await message.reply(`Подключился к **${voiceChannel.name}** и начал запись 🎙`);
    return;
  }

  const username = message.member?.displayName || message.author.username;
  const attachments = [...message.attachments.values()];
  if (!message.content && attachments.length === 0) return;

  const referencedDiscordId = message.reference?.messageId || null;
  const replyToTgMsgId = referencedDiscordId
    ? (discordIdToTgId.get(referencedDiscordId) ?? null)
    : null;

  try {
    let sentTgMsg = null;

    if (attachments.length === 0) {
      sentTgMsg = await sendTelegramMessage(`${username}: ${message.content}`, replyToTgMsgId);
    } else {
      const caption = buildTelegramCaption(username, message.content);
      for (let i = 0; i < attachments.length; i++) {
        const tgMsg = await sendDiscordAttachmentToTelegram(
          attachments[i],
          i === 0 ? caption : undefined,
          i === 0 ? replyToTgMsgId : null
        );
        if (i === 0) sentTgMsg = tgMsg;
      }
    }

    if (sentTgMsg?.message_id) {
      registerMessageIds(message.id, sentTgMsg.message_id);
    }
  } catch (err) {
    console.error('Ошибка отправки в Telegram:', err.message);
  }
});

discordClient.once('ready', () => {
  console.log(`Discord-бот запущен как ${discordClient.user.tag}`);
});
discordClient.login(DISCORD_BOT_TOKEN);

// ===== Запись голосового канала Discord -> Telegram =====

const SILENCE_TIMEOUT_MS = 2000;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

// userId -> { pcmChunks: Buffer[], silenceTimer: Timeout|null }
const voiceRecorders = new Map();

/**
 * Конвертирует сырой PCM s16le -> OGG/Opus через ffmpeg-static.
 * Записывает результат в outPath, возвращает Promise<void>.
 */
function pcmToOgg(pcmBuffer, outPath) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `vc_in_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`);

    fs.writeFileSync(tmpIn, pcmBuffer);

    const ff = spawn(ffmpegPath, [
      '-y',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-i', tmpIn,
      '-c:a', 'libopus',
      '-b:a', '64k',
      outPath,
    ]);

    ff.stdout.resume();
    ff.stderr.resume();

    ff.on('close', (code) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (code !== 0) {
        try { fs.unlinkSync(outPath); } catch {}
        return reject(new Error(`ffmpeg завершился с кодом ${code}`));
      }
      resolve();
    });

    ff.on('error', (err) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      reject(err);
    });
  });
}

/**
 * Завершает запись для userId, конвертирует и отправляет голосовое в Telegram.
 */
async function flushRecording(userId, displayName) {
  const rec = voiceRecorders.get(userId);
  if (!rec || rec.pcmChunks.length === 0) {
    voiceRecorders.delete(userId);
    return;
  }

  const pcmBuffer = Buffer.concat(rec.pcmChunks);
  voiceRecorders.delete(userId);

  // Минимум 0.5 секунды, иначе не отправляем
  const minBytes = SAMPLE_RATE * CHANNELS * 2 * 0.5;
  if (pcmBuffer.length < minBytes) return;

  const tmpOgg = path.join(os.tmpdir(), `tg_voice_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);

  try {
    await pcmToOgg(pcmBuffer, tmpOgg);

    // Отправляем как ReadStream — node-telegram-bot-api надёжно работает с потоком
    const fileStream = fs.createReadStream(tmpOgg);
    await tgBot.sendVoice(
      TELEGRAM_CHAT_ID,
      fileStream,
      { caption: `🎙 ${displayName}` },
      { filename: 'voice.ogg', contentType: 'audio/ogg' }
    );

    const sizeKb = (fs.statSync(tmpOgg).size / 1024).toFixed(1);
    console.log(`Голосовое от ${displayName} → Telegram (${sizeKb} КБ)`);
  } catch (err) {
    console.error(`Ошибка отправки голосового (${displayName}):`, err.message);
  } finally {
    try { fs.unlinkSync(tmpOgg); } catch {}
  }
}

/**
 * Подключается к голосовому каналу и начинает запись участников.
 */
async function joinAndRecord(voiceChannel, guild) {
  // Если уже подключены — отключаемся
  const existing = getVoiceConnection(guild.id);
  if (existing) {
    existing.destroy();
    voiceRecorders.clear();
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    console.log(`Подключился к голосовому каналу: ${voiceChannel.name}`);
  } catch (err) {
    console.error('Не удалось подключиться к голосовому каналу:', err.message);
    connection.destroy();
    return;
  }

  const receiver = connection.receiver;
  const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);

  // Множество userId, для которых уже открыт аудио-стрим в этой сессии.
  // Нужно чтобы не открывать второй стрим если speaking.start сработал повторно
  // пока стрим ещё жив.
  const activeStreams = new Set();

  receiver.speaking.on('start', (userId) => {
    const member = voiceChannel.guild.members.cache.get(userId);
    const displayName = member?.displayName || member?.user?.username || String(userId);

    // Если буфер уже есть — просто сбрасываем таймер тишины и продолжаем писать
    if (voiceRecorders.has(userId)) {
      const rec = voiceRecorders.get(userId);
      if (rec.silenceTimer) {
        clearTimeout(rec.silenceTimer);
        rec.silenceTimer = null;
      }
    } else {
      voiceRecorders.set(userId, { pcmChunks: [], silenceTimer: null, displayName });
    }

    // Не открываем второй стрим если уже есть активный
    if (activeStreams.has(userId)) return;
    activeStreams.add(userId);

    // Manual — стрим живёт пока мы сами его не закроем.
    // Тишину отслеживаем через таймер, который сбрасывается на каждом пакете.
    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    audioStream.on('data', (opusPacket) => {
      const rec = voiceRecorders.get(userId);
      if (!rec) return;

      // Сбрасываем таймер тишины при каждом новом пакете
      if (rec.silenceTimer) {
        clearTimeout(rec.silenceTimer);
      }
      rec.silenceTimer = setTimeout(() => {
        // 2 сек тишины — завершаем стрим и отправляем
        audioStream.destroy();
        activeStreams.delete(userId);
        flushRecording(userId, displayName);
      }, SILENCE_TIMEOUT_MS);

      try {
        const pcm = encoder.decode(opusPacket);
        rec.pcmChunks.push(pcm);
      } catch {
        // битый пакет — пропускаем
      }
    });

    audioStream.on('close', () => {
      activeStreams.delete(userId);
    });

    audioStream.on('error', () => {
      activeStreams.delete(userId);
    });
  });

  // При дисконнекте — сбрасываем все незавершённые записи перед уничтожением
  async function flushAllAndDestroy() {
    const flushPromises = [];
    for (const [uid, rec] of voiceRecorders.entries()) {
      if (rec.silenceTimer) clearTimeout(rec.silenceTimer);
      flushPromises.push(flushRecording(uid, rec.displayName));
    }
    await Promise.allSettled(flushPromises);
    activeStreams.clear();
  }

  // Автоматическое переподключение при обрыве
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      await flushAllAndDestroy();
      connection.destroy();
      console.log('Отключился от голосового канала.');
    }
  });
}

// ===== Telegram -> Discord =====

function resolveTelegramFileName(msg, url) {
  if (msg.document?.file_name) return msg.document.file_name;
  if (msg.video?.file_name) return msg.video.file_name;
  return fileNameFromUrl(url);
}

function extractTelegramMedia(msg) {
  if (msg.voice)      return { fileId: msg.voice.file_id,      kind: 'voice' };
  if (msg.video_note) return { fileId: msg.video_note.file_id, kind: 'video_note' };
  if (msg.photo?.length)
    return { fileId: msg.photo[msg.photo.length - 1].file_id, kind: 'photo' };
  if (msg.video)     return { fileId: msg.video.file_id,     kind: 'video' };
  if (msg.animation) return { fileId: msg.animation.file_id, kind: 'animation' };
  if (msg.document)  return { fileId: msg.document.file_id,  kind: 'document' };
  return null;
}

tgBot.on('message', async (msg) => {
  if (!msg.chat || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) return;

  const from = msg.from;
  if (!from || from.is_bot) return;

  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    from.username ||
    'Unknown';

  const text = msg.text || msg.caption || '';
  const media = extractTelegramMedia(msg);
  if (!text && !media) return;

  const referencedTgId = msg.reply_to_message?.message_id ?? null;
  const replyDiscordMsgId = referencedTgId
    ? (tgIdToDiscordId.get(referencedTgId) ?? null)
    : null;

  try {
    let fileUrl = null;
    let fileName = null;
    let downloadFailed = false;

    if (media) {
      try {
        fileUrl = await tgBot.getFileLink(media.fileId);

        if (media.kind === 'voice') {
          fileName = `voice_${from.id}_${msg.message_id}.ogg`;
        } else if (media.kind === 'video_note') {
          fileName = `video_note_${from.id}_${msg.message_id}.mp4`;
        } else {
          fileName = resolveTelegramFileName(msg, fileUrl);
        }
      } catch (err) {
        downloadFailed = true;
        console.error('Не удалось получить файл из Telegram (> 20 МБ?):', err.message);
      }
    }

    let content = downloadFailed
      ? `${text ? text + '\n' : ''}[не удалось переслать файл — он больше 20 МБ]`
      : text;

    if (media?.kind === 'voice'      && !content) content = '🎙 Голосовое сообщение';
    if (media?.kind === 'video_note' && !content) content = '⭕ Видео-кружок';

    let sentDiscordMsgId = null;

    if (DISCORD_WEBHOOK_URL) {
      const avatarUrl = await getTelegramAvatarUrl(from.id);
      const webhookUrlWithWait = DISCORD_WEBHOOK_URL.includes('?')
        ? DISCORD_WEBHOOK_URL + '&wait=true'
        : DISCORD_WEBHOOK_URL + '?wait=true';

      sentDiscordMsgId = await sendToDiscordWebhookWithId({
        webhookUrl: webhookUrlWithWait,
        username: displayName,
        avatarUrl,
        content,
        fileUrl,
        fileName,
        replyDiscordMsgId,
      });
    } else {
      const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
      const prefix = `**${displayName}**${content ? `: ${content}` : ''}`;
      const sendOpts = fileUrl
        ? { content: prefix, files: [{ attachment: fileUrl, name: fileName }] }
        : { content: prefix };

      if (replyDiscordMsgId) {
        sendOpts.reply = { messageReference: replyDiscordMsgId, failIfNotExists: false };
      }

      const sent = await channel.send(sendOpts);
      sentDiscordMsgId = sent.id;
    }

    if (sentDiscordMsgId) {
      registerMessageIds(sentDiscordMsgId, msg.message_id);
    }
  } catch (err) {
    console.error('Ошибка отправки в Discord:', err.message);
  }
});

// ===== Express + Telegram Webhook =====
const app = express();
app.use(express.json());
const port = PORT || 3000;

app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  tgBot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Webhook слушает на порту ${port}`);
  if (WEBHOOK_DOMAIN) {
    tgBot
      .setWebHook(`${WEBHOOK_DOMAIN}/bot${TELEGRAM_BOT_TOKEN}`)
      .then(() => console.log('Telegram webhook установлен'))
      .catch((err) => console.error('Ошибка установки webhook:', err.message));
  } else {
    console.warn('WEBHOOK_DOMAIN не задан — Telegram webhook не установлен');
  }
});
