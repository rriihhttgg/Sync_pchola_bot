/**
 * Discord <-> Telegram bridge bot
 *
 * Discord -> Telegram: бот слушает канал и пересылает текст и медиа (фото/видео/gif/документы)
 * Telegram -> Discord: бот слушает чат и пересылает текст и медиа через Discord-вебхук,
 *                       подставляя имя и аватарку отправителя из Telegram.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  DISCORD_WEBHOOK_URL,     // URL вебхука канала, см. инструкцию ниже
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PORT,
  WEBHOOK_DOMAIN,          // например: https://your-app.railway.app
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

// ---------- Кэш аватарок Telegram-пользователей ----------
const avatarCache = new Map(); // userId -> { url, expires }
const AVATAR_TTL_MS = 30 * 60 * 1000; // 30 минут

async function getTelegramAvatarUrl(userId) {
  const cached = avatarCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.url;

  try {
    const photos = await tgBot.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.photos.length) {
      avatarCache.set(userId, { url: null, expires: Date.now() + AVATAR_TTL_MS });
      return null;
    }
    const fileId = photos.photos[0][0].file_id; // самый маленький размер — для аватара достаточно
    const url = await tgBot.getFileLink(fileId);
    avatarCache.set(userId, { url, expires: Date.now() + AVATAR_TTL_MS });
    return url;
  } catch (err) {
    console.error('Не удалось получить аватар Telegram:', err.message);
    return null;
  }
}

// ---------- Вспомогательные функции ----------

// Discord запрещает в username вебхука подстроки "discord"/"clyde" и ограничивает длину 80 символами
function sanitizeWebhookUsername(name) {
  let clean = String(name)
    .replace(/discord/gi, 'disc0rd')
    .replace(/clyde/gi, 'клайд')
    .trim();
  if (!clean) clean = 'Telegram user';
  return clean.slice(0, 80);
}

// Контент вебхука ограничен 2000 символами — режем длинные сообщения на части
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

// Отправка в Discord через вебхук: текст и/или один файл (фото, видео, gif, документ)
async function sendToDiscordWebhook({ username, avatarUrl, content, fileUrl, fileName }) {
  const baseFields = {
    username: sanitizeWebhookUsername(username),
    avatar_url: avatarUrl || undefined,
    allowed_mentions: { parse: [] }, // текст из Telegram не должен создавать @everyone/упоминания ролей
  };

  if (fileUrl) {
    // Скачиваем файл из Telegram и отправляем как настоящее вложение Discord —
    // так фото/видео показываются превью, а не просто ссылкой
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`Не удалось скачать файл из Telegram (${fileRes.status})`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const name = fileName || 'file';

    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        ...baseFields,
        content: content ? content.slice(0, 2000) : undefined,
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

  for (const chunk of splitMessage(content || '')) {
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

// ===== Discord -> Telegram =====

function buildTelegramCaption(username, content) {
  const text = content ? `${username}: ${content}` : username;
  return text.slice(0, 1024); // лимит подписи в Telegram
}

function getDiscordAttachmentKind(att) {
  const type = att.contentType || '';
  const name = (att.name || '').toLowerCase();
  if (type === 'image/gif' || name.endsWith('.gif')) return 'animation';
  if (type.startsWith('image/') || /\.(jpe?g|png|webp)$/.test(name)) return 'photo';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'video';
  return 'document';
}

async function sendDiscordAttachmentToTelegram(att, caption) {
  const kind = getDiscordAttachmentKind(att);
  const opts = caption ? { caption } : {};
  if (kind === 'photo') {
    await tgBot.sendPhoto(TELEGRAM_CHAT_ID, att.url, opts);
  } else if (kind === 'video') {
    await tgBot.sendVideo(TELEGRAM_CHAT_ID, att.url, opts);
  } else if (kind === 'animation') {
    await tgBot.sendAnimation(TELEGRAM_CHAT_ID, att.url, opts);
  } else {
    await tgBot.sendDocument(TELEGRAM_CHAT_ID, att.url, opts);
  }
}

discordClient.on('messageCreate', async (message) => {
  // Только нужный канал
  if (message.channelId !== DISCORD_CHANNEL_ID) return;
  // Игнорируем сообщения, отправленные через вебхук (в т.ч. наш собственный) — защита от петли
  if (message.webhookId) return;
  // Игнорируем обычных ботов
  if (message.author.bot) return;

  const username = message.member?.displayName || message.author.username;
  const attachments = [...message.attachments.values()];

  if (!message.content && attachments.length === 0) return;

  try {
    if (attachments.length === 0) {
      await tgBot.sendMessage(TELEGRAM_CHAT_ID, `${username}: ${message.content}`);
      return;
    }

    // Подпись добавляем только к первому файлу, остальные идут без подписи
    const caption = buildTelegramCaption(username, message.content);
    for (let i = 0; i < attachments.length; i++) {
      await sendDiscordAttachmentToTelegram(attachments[i], i === 0 ? caption : undefined);
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
    return { fileId: msg.photo[msg.photo.length - 1].file_id }; // самое крупное фото
  }
  if (msg.video) return { fileId: msg.video.file_id };
  if (msg.animation) return { fileId: msg.animation.file_id };
  if (msg.document) return { fileId: msg.document.file_id };
  return null;
}

tgBot.on('message', async (msg) => {
  // Только нужный чат
  if (!msg.chat || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) return;

  const from = msg.from;
  // Игнорируем ботов — защита от петли
  if (!from || from.is_bot) return;

  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    from.username ||
    'Unknown';

  const text = msg.text || msg.caption || '';
  const media = extractTelegramMedia(msg);

  // Стикеры, голосовые и т.п. пока не пересылаем
  if (!text && !media) return;

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

    if (DISCORD_WEBHOOK_URL) {
      const avatarUrl = await getTelegramAvatarUrl(from.id);
      await sendToDiscordWebhook({ username: displayName, avatarUrl, content, fileUrl, fileName });
    } else {
      // Запасной вариант, если вебхук не настроен — отправка от имени бота
      const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
      const prefix = `**${displayName}**${content ? `: ${content}` : ''}`;
      if (fileUrl) {
        await channel.send({ content: prefix, files: [{ attachment: fileUrl, name: fileName }] });
      } else {
        await channel.send(prefix);
      }
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
