/**
 * Discord <-> Telegram bridge bot
 *
 * Discord -> Telegram: бот в Discord слушает сообщения в одном канале
 *   и пересылает их в Telegram-чат в формате "username: текст".
 *
 * Telegram -> Discord: бот в Telegram слушает сообщения в одном чате
 *   и пересылает их в Discord через webhook, подставляя имя и аватар
 *   отправителя (Discord webhook поддерживает username + avatar_url
 *   на каждое сообщение).
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,      // канал, который слушаем и куда шлём вебхуком
  DISCORD_WEBHOOK_URL,     // вебхук этого же канала (создать в настройках канала)
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,        // chat_id телеграм-чата/группы
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
const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ===== Discord -> Telegram =====
discordClient.on('messageCreate', async (message) => {
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Игнорируем любые сообщения от ботов: обычных ботов (включая нашего
  // собственного) и сообщения, пришедшие через вебхук (message.webhookId
  // выставлен, когда сообщение отправлено вебхуком, в т.ч. нашим же
  // мостом из Telegram) — иначе получится бесконечная петля.
  if (message.author.bot) return;
  if (message.webhookId) return;

  if (!message.content) return; // пропускаем чисто медийные сообщения без текста, можно дополнить

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

// ===== Telegram -> Discord (через вебхук) =====
tgBot.on('message', async (msg) => {
  if (!msg.chat || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) return;
  if (!msg.text) return; // можно дополнительно обработать фото/документы

  const from = msg.from;

  // Игнорируем сообщения от любых ботов — включая наш собственный
  // Discord-бот, если бы он вдруг писал в этот чат напрямую, и
  // сторонние боты в группе — чтобы не создавать петли и не дублировать
  // чужие пересылки.
  if (!from || from.is_bot) return;
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

  // Аватар пользователя Telegram
  let avatarUrl;
  try {
    avatarUrl = await getTelegramAvatarUrl(from.id);
  } catch (err) {
    avatarUrl = undefined; // если не удалось получить — Discord возьмёт дефолтный аватар вебхука
  }

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      username: displayName,
      avatar_url: avatarUrl,
      content: msg.text,
    });
  } catch (err) {
    console.error('Ошибка отправки в Discord:', err.response?.data || err.message);
  }
});

// Получение прямой ссылки на аватар пользователя Telegram через Bot API
async function getTelegramAvatarUrl(userId) {
  const photos = await tgBot.getUserProfilePhotos(userId, { limit: 1 });
  if (!photos.photos.length) return undefined;

  const fileId = photos.photos[0][0].file_id; // самое маленькое разрешение, для аватарки достаточно
  const file = await tgBot.getFile(fileId);
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}
