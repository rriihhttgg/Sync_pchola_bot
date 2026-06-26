require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  Collection,
} = require("discord.js");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

// ─── DATA FILES ────────────────────────────────────────────────────────────────
const RANKS_FILE = "./ranks.json";
const PACKS_FILE = "./packs.json";

function loadJSON(file, defaultVal) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultVal, null, 2));
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ranks.json: { "userId": "S" | "A" | "B" | "C" | "D" | "F" }
let ranks = loadJSON(RANKS_FILE, {});
// packs.json: { "packName": [ { name, description } ] }
let packs = loadJSON(PACKS_FILE, {});

// ─── RANK HELPERS ──────────────────────────────────────────────────────────────
const RANK_ORDER = ["F", "D", "C", "B", "A", "S"];

function getRank(userId) {
  if (userId === ADMIN_ID) return "S";
  return ranks[userId] ?? "F";
}

function setRank(userId, rank) {
  ranks[userId] = rank;
  saveJSON(RANKS_FILE, ranks);
}

function rankIndex(r) {
  return RANK_ORDER.indexOf(r);
}

function hasRank(userId, minRank) {
  return rankIndex(getRank(userId)) >= rankIndex(minRank);
}

function rankUpOf(rank) {
  const i = rankIndex(rank);
  return i < RANK_ORDER.length - 1 ? RANK_ORDER[i + 1] : null;
}

function rankDownOf(rank) {
  const i = rankIndex(rank);
  return i > 0 ? RANK_ORDER[i - 1] : null;
}

// ─── TIME PARSER ───────────────────────────────────────────────────────────────
// Supports: 1h23m45s / 1h / 45m / 90s / 1h 23m / etc.
function parseTime(str) {
  if (!str) return null;
  let total = 0;
  const regex = /(\d+)\s*([hHmMsS])/g;
  let match;
  let found = false;
  while ((match = regex.exec(str)) !== null) {
    found = true;
    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "h") total += val * 3600;
    else if (unit === "m") total += val * 60;
    else if (unit === "s") total += val;
  }
  // fallback: plain number = seconds
  if (!found) {
    const plain = parseInt(str);
    if (!isNaN(plain)) {
      total = plain;
      found = true;
    }
  }
  return found ? total * 1000 : null; // ms
}

function formatTime(ms) {
  let s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);   s %= 60;
  const parts = [];
  if (h) parts.push(`${h}ч`);
  if (m) parts.push(`${m}м`);
  if (s) parts.push(`${s}с`);
  return parts.join(" ") || "0с";
}

// ─── CLIENT ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── SLASH COMMANDS REGISTRATION ──────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName("l_pack")
    .setDescription("Показать список паков команд"),
].map((cmd) => cmd.toJSON());

client.once("ready", async () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: slashCommands,
    });
    console.log("✅ Slash-команды зарегистрированы глобально");
  } catch (err) {
    console.error("Ошибка регистрации slash-команд:", err);
  }
});

// ─── SLASH COMMAND HANDLER ─────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  // ── /l_pack ──────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === "l_pack") {
    packs = loadJSON(PACKS_FILE, {}); // reload
    const packNames = Object.keys(packs);
    if (packNames.length === 0) {
      return interaction.reply({ content: "📦 Паков пока нет.", ephemeral: true });
    }

    const rows = [];
    let row = new ActionRowBuilder();
    let count = 0;
    for (const name of packNames) {
      if (count > 0 && count % 5 === 0) {
        rows.push(row);
        row = new ActionRowBuilder();
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`pack_view:${name}`)
          .setLabel(`📦 ${name}`)
          .setStyle(ButtonStyle.Primary)
      );
      count++;
    }
    rows.push(row);

    const embed = new EmbedBuilder()
      .setTitle("📦 Список паков")
      .setDescription("Нажми на кнопку, чтобы посмотреть команды пака")
      .setColor(0x5865f2);

    return interaction.reply({ embeds: [embed], components: rows, ephemeral: false });
  }

  // ── Button: pack_view:<name> ──────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pack_view:")) {
    packs = loadJSON(PACKS_FILE, {});
    const packName = interaction.customId.slice("pack_view:".length);
    const commands = packs[packName];
    if (!commands || commands.length === 0) {
      return interaction.reply({ content: `📦 Пак **${packName}** пустой.`, ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 Пак: ${packName}`)
      .setColor(0x57f287)
      .setDescription(
        commands.map((c) => `**${c.name}** — ${c.description}`).join("\n")
      );

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ─── PREFIX COMMAND HANDLER ────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  const authorId = message.author.id;
  const authorRank = getRank(authorId);

  // ── Утилита: получить целевого пользователя ──────────────────────────────────
  async function resolveTarget(argIndex = 0) {
    // 1) Ответ на сообщение
    if (message.reference) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        return ref.member || await message.guild.members.fetch(ref.author.id).catch(() => null);
      } catch { return null; }
    }
    // 2) Упоминание или ID из аргумента
    const raw = args[argIndex];
    if (!raw) return null;
    const id = raw.replace(/[<@!>]/g, "");
    return message.guild.members.fetch(id).catch(() => null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !mute [пользователь] [время] [причина...]
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "mute") {
    if (!hasRank(authorId, "B")) {
      return message.reply("❌ Нужен ранг **B** или выше.");
    }

    let target, timeStr, reason;

    if (message.reference) {
      // !mute [время] [причина...]
      target = await resolveTarget();
      timeStr = args[0];
      reason = args.slice(1).join(" ") || "Не указана";
    } else {
      // !mute @user [время] [причина...]
      target = await resolveTarget(0);
      timeStr = args[1];
      reason = args.slice(2).join(" ") || "Не указана";
    }

    if (!target) return message.reply("❌ Пользователь не найден.");

    const ms = parseTime(timeStr);
    if (!ms) return message.reply("❌ Укажи время, например: `1h30m`, `45m`, `90s`.");

    try {
      await target.timeout(ms, reason);
      const embed = new EmbedBuilder()
        .setTitle("🔇 Мут выдан")
        .setColor(0xfee75c)
        .addFields(
          { name: "Пользователь", value: `${target.user.tag}`, inline: true },
          { name: "Время", value: formatTime(ms), inline: true },
          { name: "Причина", value: reason }
        );
      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply(`❌ Не удалось замутить: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !ban [пользователь] [причина...]
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "ban") {
    if (!hasRank(authorId, "B")) {
      return message.reply("❌ Нужен ранг **B** или выше.");
    }

    let target, reason;
    if (message.reference) {
      target = await resolveTarget();
      reason = args.join(" ") || "Не указана";
    } else {
      target = await resolveTarget(0);
      reason = args.slice(1).join(" ") || "Не указана";
    }

    if (!target) return message.reply("❌ Пользователь не найден.");

    try {
      await target.ban({ reason });
      const embed = new EmbedBuilder()
        .setTitle("🔨 Бан выдан")
        .setColor(0xed4245)
        .addFields(
          { name: "Пользователь", value: `${target.user.tag}`, inline: true },
          { name: "Причина", value: reason }
        );
      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply(`❌ Не удалось забанить: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !kick [пользователь] [причина...]
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "kick") {
    if (!hasRank(authorId, "B")) {
      return message.reply("❌ Нужен ранг **B** или выше.");
    }

    let target, reason;
    if (message.reference) {
      target = await resolveTarget();
      reason = args.join(" ") || "Не указана";
    } else {
      target = await resolveTarget(0);
      reason = args.slice(1).join(" ") || "Не указана";
    }

    if (!target) return message.reply("❌ Пользователь не найден.");

    try {
      await target.kick(reason);
      const embed = new EmbedBuilder()
        .setTitle("👢 Кик выдан")
        .setColor(0xe67e22)
        .addFields(
          { name: "Пользователь", value: `${target.user.tag}`, inline: true },
          { name: "Причина", value: reason }
        );
      return message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.reply(`❌ Не удалось кикнуть: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !up [пользователь] — повышение ранга
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "up") {
    if (!hasRank(authorId, "A")) {
      return message.reply("❌ Нужен ранг **A** или выше.");
    }

    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");

    const targetId = target.user.id;
    const currentRank = getRank(targetId);
    const newRank = rankUpOf(currentRank);

    if (!newRank) {
      return message.reply(`❌ **${target.user.tag}** уже на максимальном ранге **${currentRank}**.`);
    }

    // A ранг может повышать максимум до A
    if (!hasRank(authorId, "S") && rankIndex(newRank) > rankIndex("A")) {
      return message.reply("❌ Ранг **A** может повышать максимум до **A**.");
    }

    setRank(targetId, newRank);
    const embed = new EmbedBuilder()
      .setTitle("⬆️ Ранг повышен")
      .setColor(0x57f287)
      .setDescription(`**${target.user.tag}**: **${currentRank}** → **${newRank}**`);
    return message.channel.send({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !down [пользователь] — понижение ранга
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "down") {
    if (!hasRank(authorId, "A")) {
      return message.reply("❌ Нужен ранг **A** или выше.");
    }

    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");

    const targetId = target.user.id;

    // Нельзя понижать S если ты не S
    if (getRank(targetId) === "S" && !hasRank(authorId, "S")) {
      return message.reply("❌ Нельзя понижать **S** ранг.");
    }

    const currentRank = getRank(targetId);
    const newRank = rankDownOf(currentRank);

    if (!newRank) {
      return message.reply(`❌ **${target.user.tag}** уже на минимальном ранге **${currentRank}**.`);
    }

    setRank(targetId, newRank);
    const embed = new EmbedBuilder()
      .setTitle("⬇️ Ранг понижен")
      .setColor(0xed4245)
      .setDescription(`**${target.user.tag}**: **${currentRank}** → **${newRank}**`);
    return message.channel.send({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !lrangs — список рангов и участников
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "lrangs") {
    ranks = loadJSON(RANKS_FILE, {});

    // Группировка по рангу
    const grouped = {};
    for (const r of RANK_ORDER) grouped[r] = [];

    // ADMIN_ID всегда S
    grouped["S"].push(ADMIN_ID);

    for (const [uid, rank] of Object.entries(ranks)) {
      if (uid === ADMIN_ID) continue; // уже добавлен
      if (grouped[rank]) grouped[rank].push(uid);
    }

    const lines = [];
    for (const r of [...RANK_ORDER].reverse()) {
      const ids = grouped[r];
      if (ids.length === 0) continue;
      const names = ids.map((id) => `<@${id}>`).join(", ");
      lines.push(`**${r} ранг:** ${names}`);
    }

    const embed = new EmbedBuilder()
      .setTitle("🏅 Список рангов")
      .setColor(0x5865f2)
      .setDescription(lines.join("\n") || "Никого нет");
    return message.channel.send({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !dw_pack <название> — создать/объявить пак (Dev группа)
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "dw_pack") {
    // Dev группа — только S
    if (!hasRank(authorId, "S")) {
      return message.reply("❌ Команда группы **Dev** — нужен ранг **S**.");
    }

    const packName = args[0];
    if (!packName) return message.reply("❌ Укажи название пака: `!dw_pack <название>`");

    packs = loadJSON(PACKS_FILE, {});
    if (packs[packName]) {
      return message.reply(`⚠️ Пак **${packName}** уже существует.`);
    }

    packs[packName] = [];
    saveJSON(PACKS_FILE, packs);

    const embed = new EmbedBuilder()
      .setTitle("📦 Пак создан")
      .setColor(0x57f287)
      .setDescription(`Пак **${packName}** успешно создан! Добавь в него команды через \`!add_pack ${packName} <команда> <описание>\`.`);
    return message.channel.send({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !add_pack <пак> <команда> <описание> — добавить команду в пак (Dev группа)
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "add_pack") {
    if (!hasRank(authorId, "S")) {
      return message.reply("❌ Команда группы **Dev** — нужен ранг **S**.");
    }

    const packName = args[0];
    const cmdName = args[1];
    const desc = args.slice(2).join(" ");

    if (!packName || !cmdName || !desc) {
      return message.reply("❌ Использование: `!add_pack <пак> <команда> <описание>`");
    }

    packs = loadJSON(PACKS_FILE, {});
    if (!packs[packName]) {
      return message.reply(`❌ Пак **${packName}** не найден. Сначала создай его через \`!dw_pack\`.`);
    }

    packs[packName].push({ name: cmdName, description: desc });
    saveJSON(PACKS_FILE, packs);

    return message.reply(`✅ Команда **${cmdName}** добавлена в пак **${packName}**.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !del_pack <название> — удалить пак (Dev группа)
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "del_pack") {
    if (!hasRank(authorId, "S")) {
      return message.reply("❌ Команда группы **Dev** — нужен ранг **S**.");
    }

    const packName = args[0];
    if (!packName) return message.reply("❌ Укажи название пака: `!del_pack <название>`");

    packs = loadJSON(PACKS_FILE, {});
    if (!packs[packName]) {
      return message.reply(`❌ Пак **${packName}** не найден.`);
    }

    delete packs[packName];
    saveJSON(PACKS_FILE, packs);
    return message.reply(`🗑️ Пак **${packName}** удалён.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !myrank — узнать свой ранг
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "myrank") {
    return message.reply(`🏅 Твой ранг: **${authorRank}**`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // !help — список команд
  // ─────────────────────────────────────────────────────────────────────────────
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📋 Команды бота")
      .setColor(0x5865f2)
      .addFields(
        {
          name: "👮 Модерация (ранг B+)",
          value: [
            "`!mute [user] [время] [причина]` — замутить (1h30m, 45m, 90s)",
            "`!ban [user] [причина]` — забанить",
            "`!kick [user] [причина]` — кикнуть",
          ].join("\n"),
        },
        {
          name: "🏅 Ранги (ранг A+)",
          value: [
            "`!up [user]` — повысить ранг",
            "`!down [user]` — понизить ранг",
            "`!lrangs` — список всех рангов",
            "`!myrank` — твой ранг",
          ].join("\n"),
        },
        {
          name: "📦 Паки команд",
          value: [
            "`/l_pack` — показать паки (кнопки)",
            "`!dw_pack <название>` — создать пак [S]",
            "`!add_pack <пак> <команда> <описание>` — добавить команду в пак [S]",
            "`!del_pack <название>` — удалить пак [S]",
          ].join("\n"),
        }
      )
      .setFooter({ text: "Поле [user] можно заменить ответом на сообщение" });
    return message.channel.send({ embeds: [embed] });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
client.login(TOKEN);
