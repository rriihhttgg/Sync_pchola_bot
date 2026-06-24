/**
 * Discord <-> Telegram bridge bot
 *
 * Discord -> Telegram: бот слушает канал и пересылает текст и медиа (фото/видео/gif/документы)
 * Telegram -> Discord: бот слушает чат и пересылает текст и медиа через Discord-вебхук,
 *                       подставляя имя и аватарку отправителя из Telegram.
 *
 * Поддержка ответов (reply):
 *   - Discord reply -> Telegram reply (бот отвечает на нужное TG-сообщение)
 *   - Telegram reply -> Discord reply (бот отвечает на нужное Discord-сообщение через webhook)
 *   Маппинг хранится в памяти (Map). При перезапуске сервиса история сбрасывается,
 *   но новые сообщения снова начинают индексироваться.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

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
  ],
  partials: [Partials.Channel],
});

// ---------- TELEGRAM ----------
const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// ---------- Маппинг сообщений (reply-цепочки) ----------
// discordIdToTgId: Discord message ID -> Telegram message ID
// tgIdToDiscordId: Telegram message ID -> Discord message ID
//
// Хранение в памяти — при перезапуске сбрасывается. Ограничиваем размер,
// чтобы процесс не рос бесконечно на долгоживущем сервере.
const MAX_MAP_SIZE = 5000;

const discordIdToTgId = new Map(); // "discordMsgId" -> tgMsgId (number)
const tgIdToDiscordId = new Map(); // tgMsgId (number) -> "discordMsgId"

function registerMessageIds(discordMsgId, tgMsgId) {
  // Чистим старые записи при превышении лимита
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

// ---------- Вспомогательные функции ----------

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
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
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

// Отправка в Discord через вебхук.
// replyDiscordMsgId — ID Discord-сообщения, на которое нужно ответить (опционально).
async function sendToDiscordWebhook({ username, avatarUrl, content, fileUrl, fileName, replyDiscordMsgId }) {
  const baseFields = {
    username: sanitizeWebhookUsername(username),
    avatar_url: avatarUrl || undefined,
    allowed_mentions: { parse: [] },
  };

  // Discord Webhooks не поддерживают message_reference напрямую,
  // поэтому цитируем оригинал через ссылку на сообщение.
  let finalContent = content || '';
  if (replyDiscordMsgId) {
    // Формируем jump-link на оригинальное сообщение
    const jumpUrl = `https://discord.com/channels/${await getGuildId()}/${DISCORD_CHANNEL_ID}/${replyDiscordMsgId}`;
    const quoteHeader = `↩️ [ответ на сообщение](${jumpUrl})\n`;
    finalContent = quoteHeader + finalContent;
  }

  if (fileUrl) {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`Не удалось скачать файл из Telegram (${fileRes.status})`);
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

    const res = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook вернул ${res.status}: ${body}`);
    }
    return;
  }

  for (const chunk of splitMessage(finalContent || '')) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseFields, content: chunk }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook вернул ${res.status}: ${body}`);
    }
  }
}

// Кэш guild ID (нужен для формирования jump-link)
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

// Отправка сообщения в Telegram с опциональным reply
async function sendTelegramMessage(text, replyToTgMsgId) {
  const opts = replyToTgMsgId
    ? { reply_to_message_id: replyToTgMsgId, allow_sending_without_reply: true }
    : {};
  return tgBot.sendMessage(TELEGRAM_CHAT_ID, text, opts);
}

// Отправка медиа в Telegram с опциональным reply
async function sendDiscordAttachmentToTelegram(att, caption, replyToTgMsgId) {
  const kind = getDiscordAttachmentKind(att);
  const opts = {
    ...(caption ? { caption } : {}),
    ...(replyToTgMsgId ? { reply_to_message_id: replyToTgMsgId, allow_sending_without_reply: true } : {}),
  };
  if (kind === 'photo') {
    return tgBot.sendPhoto(TELEGRAM_CHAT_ID, att.url, opts);
  } else if (kind === 'video') {
    return tgBot.sendVideo(TELEGRAM_CHAT_ID, att.url, opts);
  } else if (kind === 'animation') {
    return tgBot.sendAnimation(TELEGRAM_CHAT_ID, att.url, opts);
  } else {
    return tgBot.sendDocument(TELEGRAM_CHAT_ID, att.url, opts);
  }
}

// ===== Discord -> Telegram =====

function buildTelegramCaption(username, content) {
  const text = content ? `${username}: ${content}` : username;
  return text.slice(0, 1024);
}

function getDiscordAttachmentKind(att) {
  const type = att.contentType || '';
  const name = (att.name || '').toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'animation';
  if (type.startsWith('image/') || /\.(jpe?g|png|webp)$/.test(name)) return 'photo';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'video';
  return 'document';
}

discordClient.on('messageCreate', async (message) => {
  if (message.channelId !== DISCORD_CHANNEL_ID) return;
  if (message.webhookId) return;
  if (message.author.bot) return;

  const username = message.member?.displayName || message.author.username;
  const attachments = [...message.attachments.values()];

  if (!message.content && attachments.length === 0) return;

  // Определяем, является ли сообщение ответом на другое
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
        // reply только на первое вложение; остальные идут без reply и без подписи
        const tgMsg = await sendDiscordAttachmentToTelegram(
          attachments[i],
          i === 0 ? caption : undefined,
          i === 0 ? replyToTgMsgId : null
        );
        if (i === 0) sentTgMsg = tgMsg;
      }
    }

    // Регистрируем маппинг, чтобы на это сообщение можно было ответить из TG
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

// ===== Telegram -> Discord =====

function resolveTelegramFileName(msg, url) {
  if (msg.document?.file_name) return msg.document.file_name;
  if (msg.video?.file_name) return msg.video.file_name;
  return fileNameFromUrl(url);
}

function extractTelegramMedia(msg) {
  if (msg.photo && msg.photo.length) {
    return { fileId: msg.photo[msg.photo.length - 1].file_id };
  }
  if (msg.video) return { fileId: msg.video.file_id };
  if (msg.animation) return { fileId: msg.animation.file_id };
  if (msg.document) return { fileId: msg.document.file_id };
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

  // Определяем, является ли сообщение ответом на другое
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
        fileName = resolveTelegramFileName(msg, fileUrl);
      } catch (err) {
        downloadFailed = true;
        console.error('Не удалось получить файл из Telegram (вероятно, больше 20 МБ):', err.message);
      }
    }

    const content = downloadFailed
      ? `${text ? text + '\n' : ''}[не удалось переслать файл — он больше 20 МБ]`
      : text;

    let sentDiscordMsgId = null;

    if (DISCORD_WEBHOOK_URL) {
      const avatarUrl = await getTelegramAvatarUrl(from.id);
      // Webhook не возвращает message ID в обычном режиме — нужно добавить ?wait=true
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
      // Запасной вариант без вебхука
      const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
      const prefix = `**${displayName}**${content ? `: ${content}` : ''}`;
      const sendOpts = fileUrl
        ? { content: prefix, files: [{ attachment: fileUrl, name: fileName }] }
        : { content: prefix };

      // reply через обычный канал поддерживается нативно
      if (replyDiscordMsgId) {
        sendOpts.reply = { messageReference: replyDiscordMsgId, failIfNotExists: false };
      }

      const sent = await channel.send(sendOpts);
      sentDiscordMsgId = sent.id;
    }

    // Регистрируем маппинг
    if (sentDiscordMsgId) {
      registerMessageIds(sentDiscordMsgId, msg.message_id);
    }
  } catch (err) {
    console.error('Ошибка отправки в Discord:', err.message);
  }
});

// Версия sendToDiscordWebhook, которая возвращает ID созданного сообщения
async function sendToDiscordWebhookWithId({ webhookUrl, username, avatarUrl, content, fileUrl, fileName, replyDiscordMsgId }) {
  const baseFields = {
    username: sanitizeWebhookUsername(username),
    avatar_url: avatarUrl || undefined,
    allowed_mentions: { parse: [] },
  };

  let finalContent = content || '';
  if (replyDiscordMsgId) {
    const jumpUrl = `https://discord.com/channels/${await getGuildId()}/${DISCORD_CHANNEL_ID}/${replyDiscordMsgId}`;
    finalContent = `↩️ [ответ на сообщение](${jumpUrl})\n` + finalContent;
  }

  if (fileUrl) {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`Не удалось скачать файл из Telegram (${fileRes.status})`);
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

    const res = await fetch(webhookUrl, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook вернул ${res.status}: ${body}`);
    }
    const data = await res.json().catch(() => null);
    return data?.id ?? null;
  }

  // Только первый чанк идёт с ?wait=true и возвращает ID;
  // последующие (редкие) чанки отправляются без ожидания
  const chunks = splitMessage(finalContent || '');
  let msgId = null;
  for (let i = 0; i < chunks.length; i++) {
    const url = i === 0 ? webhookUrl : DISCORD_WEBHOOK_URL;
    const res = await fetch(url, {
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
