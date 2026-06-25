const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

// Хранилище в памяти
// voiceData: { "userId": totalSeconds }
// sessions: { "userId": unixTimestampMs }
const voiceData = {};
const sessions = {};

// ──────────────────────────────────────────
//  Утилиты
// ──────────────────────────────────────────

function formatTime(seconds) {
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h}ч`);
  if (m) parts.push(`${m}м`);
  if (s || parts.length === 0) parts.push(`${s}с`);
  return parts.join(" ");
}

function getCombined(guild) {
  const combined = { ...voiceData };

  for (const [userId, startMs] of Object.entries(sessions)) {
    const elapsed = (Date.now() - startMs) / 1000;
    combined[userId] = (combined[userId] || 0) + elapsed;
  }

  return Object.entries(combined)
    .map(([userId, secs]) => {
      const member = guild.members.cache.get(userId);
      const name = member ? member.displayName : `Участник #${userId}`;
      return { userId, secs, name };
    })
    .sort((a, b) => b.secs - a.secs);
}

// ──────────────────────────────────────────
//  События
// ──────────────────────────────────────────

client.once("ready", () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);

  // Отмечаем всех кто уже в войсе
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.isVoiceBased()) {
        for (const member of channel.members.values()) {
          if (!member.user.bot) {
            sessions[member.id] = Date.now();
            console.log(`  📌 Уже в войсе: ${member.displayName}`);
          }
        }
      }
    }
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const userId = member.id;

  const joinedVoice = !oldState.channelId && newState.channelId;
  const leftVoice = oldState.channelId && !newState.channelId;
  const switchedChannel =
    oldState.channelId &&
    newState.channelId &&
    oldState.channelId !== newState.channelId;

  if (joinedVoice) {
    sessions[userId] = Date.now();
    console.log(`➡️  ${member.displayName} вошёл в «${newState.channel.name}»`);
  } else if (leftVoice) {
    if (sessions[userId]) {
      const elapsed = (Date.now() - sessions[userId]) / 1000;
      delete sessions[userId];
      voiceData[userId] = (voiceData[userId] || 0) + elapsed;
      console.log(
        `⬅️  ${member.displayName} вышел — +${formatTime(elapsed)}, итого: ${formatTime(voiceData[userId])}`
      );
    }
  } else if (switchedChannel) {
    console.log(
      `🔄 ${member.displayName}: «${oldState.channel.name}» → «${newState.channel.name}»`
    );
  }
});

// ──────────────────────────────────────────
//  Команды
// ──────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const cmd = message.content.trim().toLowerCase();

  // !lvoice — таблица в чате
  if (cmd === "!lvoice") {
    const rows = getCombined(message.guild);
    if (rows.length === 0) {
      return message.channel.send("📊 Пока никто не сидел в войс-чате.");
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = [
      "```",
      "🎙️  СТАТИСТИКА ГОЛОСОВЫХ ЧАТОВ",
      "─".repeat(38),
    ];

    rows.forEach(({ secs, name }, i) => {
      const prefix = medals[i] ?? `${i + 1}.`;
      const nameShort = name.length > 20 ? name.slice(0, 19) + "…" : name;
      lines.push(
        `${prefix} ${nameShort.padEnd(22)} ${formatTime(secs).padStart(10)}`
      );
    });

    lines.push("─".repeat(38), `Всего участников: ${rows.length}`, "```");
    return message.channel.send(lines.join("\n"));
  }

  // !myvoice — личное время
  if (cmd === "!myvoice") {
    const userId = message.author.id;
    let total = voiceData[userId] || 0;
    if (sessions[userId]) {
      total += (Date.now() - sessions[userId]) / 1000;
    }

    if (total === 0) {
      return message.channel.send(
        `🎙️ ${message.author.displayName}, ты ещё не сидел в войс-чатах.`
      );
    }
    return message.channel.send(
      `🎙️ **${message.member.displayName}**, твоё суммарное время в войсе: **${formatTime(total)}**`
    );
  }

  // !getvoice — скачать файлы
  if (cmd === "!getvoice") {
    const rows = getCombined(message.guild);
    if (rows.length === 0) {
      return message.channel.send("📊 Пока нет данных для выгрузки.");
    }

    const now = new Date();
    const nowStr = now.toLocaleString("ru-RU", { hour12: false });
    const dateTag = now.toISOString().slice(0, 10).replace(/-/g, "");
    const medals = ["🥇", "🥈", "🥉"];

    // TXT
    const txtLines = [
      "СТАТИСТИКА ГОЛОСОВЫХ ЧАТОВ",
      `Сформировано: ${nowStr}`,
      "=".repeat(42),
      `${"#".padEnd(4)} ${"Участник".padEnd(24)} ${"Время".padStart(10)}`,
      "-".repeat(42),
    ];
    rows.forEach(({ secs, name }, i) => {
      const prefix = medals[i] ?? `${i + 1}.`;
      txtLines.push(`${prefix.padEnd(4)} ${name.padEnd(24)} ${formatTime(secs).padStart(10)}`);
    });
    txtLines.push("=".repeat(42), `Всего участников: ${rows.length}`);
    const txtBuffer = Buffer.from(txtLines.join("\n"), "utf-8");

    // JSON
    const jsonPayload = {
      generated_at: nowStr,
      total_members: rows.length,
      stats: rows.map(({ userId, secs, name }, i) => ({
        rank: i + 1,
        user_id: userId,
        display_name: name,
        total_seconds: Math.round(secs * 10) / 10,
        formatted: formatTime(secs),
      })),
    };
    const jsonBuffer = Buffer.from(
      JSON.stringify(jsonPayload, null, 2),
      "utf-8"
    );

    return message.channel.send({
      content: `📁 Статистика голосовых чатов на **${nowStr}**`,
      files: [
        new AttachmentBuilder(txtBuffer, { name: `voice_stats_${dateTag}.txt` }),
        new AttachmentBuilder(jsonBuffer, { name: `voice_stats_${dateTag}.json` }),
      ],
    });
  }

  // !resetvoice — сброс (только администратор)
  if (cmd === "!resetvoice") {
    if (!message.member.permissions.has("Administrator")) {
      return message.channel.send("❌ Эта команда только для администраторов.");
    }
    for (const key of Object.keys(voiceData)) delete voiceData[key];
    for (const key of Object.keys(sessions)) delete sessions[key];
    return message.channel.send("🗑️ Статистика голосовых чатов сброшена.");
  }
});

client.login(process.env.DISCORD_TOKEN);
