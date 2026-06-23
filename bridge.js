/**
 * Discord <-> Telegram bridge bot
 *
 * Discord -> Telegram: бот слушает канал и пересылает "username: текст"
 * Telegram -> Discord: бот слушает чат и пересылает "username: текст" через channel.send()
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
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

// ===== Discord -> Telegram =====
discordClient.on('messageCreate', async (message) => {
  // Только нужный канал
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Игнорируем ботов и сообщения от самого себя — защита от петли
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

  const text = `**${displayName}**: ${msg.text}`;

  try {
    // Получаем канал и отправляем через бота напрямую
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    await channel.send(text);
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
