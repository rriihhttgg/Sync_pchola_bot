/**
 * Discord <-> Telegram bridge bot
 *
 * Discord -> Telegram: бот слушает канал и пересылает "username: текст"
 * Telegram -> Discord: бот слушает чат и пересылает сообщение через Discord-вебхук,
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
// Чтобы не дёргать Telegram API на каждое сообщение, храним ссылку на аватар
// в памяти процесса на ограниченное время.
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
    // Берём самый маленький размер фото — для аватарки в Discord этого достаточно
    const fileId = photos.photos[0][0].file_id;
    const url = await tgBot.getFileLink(fileId);
    avatarCache.set(userId, { url, expires: Date.now() + AVATAR_TTL_MS });
    return url;
  } catch (err) {
    console.error('Не удалось получить аватар Telegram:', err.message);
    return null;
  }
}

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

async function sendToDiscordWebhook({ username, avatarUrl, content }) {
  for (const chunk of splitMessage(content)) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: chunk,
        username: sanitizeWebhookUsername(username),
        avatar_url: avatarUrl || undefined,
        allowed_mentions: { parse: [] }, // чтобы текст из Telegram не мог случайно упомянуть @everyone/роли
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Discord webhook вернул ${res.status}: ${body}`);
    }
  }
}

// ===== Discord -> Telegram =====
discordClient.on('messageCreate', async (message) => {
  // Только нужный канал
  if (message.channelId !== DISCORD_CHANNEL_ID) return;
  // Игнорируем сообщения, отправленные через вебхук (в т.ч. наш собственный) — защита от петли
  if (message.webhookId) return;
  // Игнорируем обычных ботов
  if (message.author.bot) return;
  if (!message.content) return;

  const username = message.member?.displayName || message.author.username;
  const text = `${username}: ${message.content}`;
  try {
    await tgBot.sendMessage(TELEGRAM_CHAT_ID, text);
  } catch (err) {
    console.error('Ошибка отправки в Telegram:', err.message);
  }
});

discordClient.once('ready', () => {
  console.log(`Discord-бот запущен как ${discordClient.user.tag}`);
});
discordClient.login(DISCORD_BOT_TOKEN);

// ===== Telegram -> Discord =====
tgBot.on('message', async (msg) => {
  // Только нужный чат
  if (!msg.chat || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) return;
  // Только текстовые сообщения
  if (!msg.text) return;

  const from = msg.from;
  // Игнорируем ботов — защита от петли
  if (!from || from.is_bot) return;

  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    from.username ||
    'Unknown';

  try {
    if (DISCORD_WEBHOOK_URL) {
      // Отправка через вебхук — подставляются имя и аватар отправителя из Telegram
      const avatarUrl = await getTelegramAvatarUrl(from.id);
      await sendToDiscordWebhook({
        username: displayName,
        avatarUrl,
        content: msg.text,
      });
    } else {
      // Запасной вариант, если вебхук не настроен — отправка от имени бота
      const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
      await channel.send(`**${displayName}**: ${msg.text}`);
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
