/**
 * Discord <-> Telegram bridge bot
 *
 * Discord --> Telegram: бот в Discord слушает сообщения в одном канале
 *   и пересылает их в Telegram-чат в формате "username: текст".
 *
 * Telegram -> Discord: бот в Telegram слушает сообщения в одном чате
 *   и пересылает их в Discord через webhook, подставляя имя и аватар
 *   отправителя (Discord webhook поддерживает username + avatar_url
 *   на каждое сообщение).
 */

require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,      // канал, который слушаем и куда шлём вебхуком
  DISCORD_WEBHOOK_URL,     // вебхук этого же канала (создать в настройках канала)
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,        // chat_id телеграм-чата/группы
  PORT,
  // Домен можно задать явно (WEBHOOK_DOMAIN), либо он подхватится
  // автоматически из переменной Railway RAILWAY_PUBLIC_DOMAIN.
  WEBHOOK_DOMAIN,
  RAILWAY_PUBLIC_DOMAIN,
} = process.env;

// ---------- Проверка обязательных переменных окружения ----------
const required = {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`❌ Не задана переменная окружения: ${key}. Проверьте .env / настройки Railway.`);
    process.exit(1);
  }
}

const domain = WEBHOOK_DOMAIN || RAILWAY_PUBLIC_DOMAIN;
if (!domain) {
  console.error(
    '❌ Не удалось определить публичный домен. Задайте WEBHOOK_DOMAIN в .env ' +
      '(например: myapp.up.railway.app, БЕЗ https:// и без слэша на конце) ' +
      'или убедитесь, что Railway передаёт RAILWAY_PUBLIC_DOMAIN.'
  );
  process.exit(1);
}
const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
const webhookUrl = `https://${domain}${webhookPath}`;

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
// Важно: не вызываем tgBot.startPolling() и не передаём {polling: true} —
// мы используем вебхук, поэтому конструктор без второго аргумента.
const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN);

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
    console.log(`[Discord -> Telegram] OK: ${text}`);
  } catch (err) {
    console.error('[Discord -> Telegram] Ошибка отправки:', err.message);
  }
});

discordClient.once('ready', () => {
  console.log(`✅ Discord-бот запущен как ${discordClient.user.tag}`);
});

discordClient.on('error', (err) => {
  console.error('Discord client error:', err);
});

discordClient.login(DISCORD_BOT_TOKEN);

// ===== Telegram -> Discord (через вебхук) =====
tgBot.on('message', async (msg) => {
  console.log('[Telegram] Входящее сообщение:', JSON.stringify({
    chatId: msg.chat?.id,
    from: msg.from?.username || msg.from?.first_name,
    text: msg.text,
  }));

  if (!msg.chat || msg.chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) {
    console.log(
      `[Telegram] Пропуск: chat.id=${msg.chat?.id} не совпадает с TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}`
    );
    return;
  }
  if (!msg.text) {
    console.log('[Telegram] Пропуск: сообщение без текста (фото/документ/стикер и т.п.)');
    return;
  }

  const from = msg.from;

  // Игнорируем сообщения от любых ботов — включая наш собственный
  // Discord-бот, если бы он вдруг писал в этот чат напрямую, и
  // сторонние боты в группе — чтобы не создавать петли и не дублировать
  // чужие пересылки.
  if (!from || from.is_bot) return;
  const displayName =
    [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

  // Аватар пользователя Telegram
  let avatarUrl;
  try {
    avatarUrl = await getTelegramAvatarUrl(from.id);
  } catch (err) {
    console.error('[Telegram] Не удалось получить аватар:', err.message);
    avatarUrl = undefined; // если не удалось получить — Discord возьмёт дефолтный аватар вебхука
  }

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      username: displayName,
      avatar_url: avatarUrl,
      content: msg.text,
    });
    console.log(`[Telegram -> Discord] OK: ${displayName}: ${msg.text}`);
  } catch (err) {
    console.error(
      '[Telegram -> Discord] Ошибка отправки:',
      err.response?.status,
      err.response?.data || err.message
    );
  }
});

tgBot.on('webhook_error', (err) => {
  console.error('[Telegram] webhook_error:', err.message);
});

// Получение прямой ссылки на аватар пользователя Telegram через Bot API
async function getTelegramAvatarUrl(userId) {
  const photos = await tgBot.getUserProfilePhotos(userId, { limit: 1 });
  if (!photos.photos.length) return undefined;

  const fileId = photos.photos[0][0].file_id; // самое маленькое разрешение, для аватарки достаточно
  const file = await tgBot.getFile(fileId);
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

// ---------- EXPRESS (приём вебхука от Telegram) ----------
const app = express();
app.use(express.json());

// Простой health-check — полезно, чтобы Railway видел, что сервис жив,
// и чтобы вручную проверить в браузере, что сервер вообще отвечает.
app.get('/', (req, res) => {
  res.send('Bridge bot is running ✅');
});

app.post(webhookPath, (req, res) => {
  console.log('[Telegram] Получен update:', JSON.stringify(req.body));
  tgBot.processUpdate(req.body);
  res.sendStatus(200);
});

const port = PORT || 3000;

app.listen(port, async () => {
  console.log(`Патриот слушает`);
  try {
    // Сначала удаляем старый вебхук (на случай, если ранее был выставлен
    // неверный URL или одновременно где-то запущен polling) — это
    // частая причина "тихого" неполучения обновлений.
    await tgBot.deleteWebHook();
    const ok = await tgBot.setWebHook(webhookUrl);
    console.log(`✅ setWebHook результат: ${ok}, URL: ${webhookUrl}`);

    const info = await tgBot.getWebHookInfo();
    console.log('ℹ️ getWebhookInfo:', JSON.stringify(info, null, 2));
    if (info.last_error_message) {
      console.warn('⚠️ Telegram сообщает об ошибке вебхука:', info.last_error_message);
    }
  } catch (err) {
    console.error('❌ Ошибка настройки Telegram-вебхука:', err.message);
  }
});

// Логируем необработанные ошибки, чтобы они не "проглатывались" молча
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
