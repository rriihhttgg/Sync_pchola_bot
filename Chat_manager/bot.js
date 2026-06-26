require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

// ─── DATA FILES ────────────────────────────────────────────────────────────────
const RANKS_FILE = "./ranks.json";
const BEE_FILE   = "./bee_data.json";

function loadJSON(file, def) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(def, null, 2));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let ranks = loadJSON(RANKS_FILE, {});

// ─── RANK SYSTEM ───────────────────────────────────────────────────────────────
const RANK_ORDER = ["F", "D", "C", "B", "A", "S"];

function getRank(userId) {
  if (userId === ADMIN_ID) return "S";
  return ranks[userId] ?? "F";
}
function setRank(userId, rank) {
  ranks[userId] = rank;
  saveJSON(RANKS_FILE, ranks);
}
function rankIndex(r)            { return RANK_ORDER.indexOf(r); }
function hasRank(userId, minR)   { return rankIndex(getRank(userId)) >= rankIndex(minR); }
function rankUpOf(r)   { const i = rankIndex(r); return i < RANK_ORDER.length - 1 ? RANK_ORDER[i+1] : null; }
function rankDownOf(r) { const i = rankIndex(r); return i > 0 ? RANK_ORDER[i-1] : null; }

// ─── TIME HELPERS ──────────────────────────────────────────────────────────────
function parseTime(str) {
  if (!str) return null;
  let total = 0, found = false;
  const re = /(\d+)\s*([hHmMsS])/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    found = true;
    const v = parseInt(m[1]), u = m[2].toLowerCase();
    if (u==="h") total += v*3600;
    else if (u==="m") total += v*60;
    else total += v;
  }
  if (!found) { const p = parseInt(str); if (!isNaN(p)) { total = p; found = true; } }
  return found ? total * 1000 : null;
}
function formatTime(ms) {
  let s = Math.floor(ms/1000);
  const h = Math.floor(s/3600); s %= 3600;
  const mn = Math.floor(s/60);  s %= 60;
  const p = [];
  if (h)  p.push(`${h}ч`);
  if (mn) p.push(`${mn}м`);
  if (s)  p.push(`${s}с`);
  return p.join(" ") || "0с";
}

// ─── BEE PACK ──────────────────────────────────────────────────────────────────
// Пчёлы: name, chance (%), pollen_per_hour, emoji
const BEES = [
  { name: "Bee",       chance: 40,   pollen: 1,    emoji: "🐝" },
  { name: "Honey bee", chance: 30,   pollen: 3,    emoji: "🍯" },
  { name: "Fuzzy bee", chance: 20,   pollen: 5,    emoji: "🟡" },
  { name: "Shy bee",   chance: 7,    pollen: 15,   emoji: "😳" },
  { name: "Cute bee",  chance: 2.5,  pollen: 35,   emoji: "🥰" },
  { name: "Queen bee", chance: 0.49, pollen: 150,  emoji: "👑" },
  { name: "Riht bee",  chance: 0.01, pollen: 2500, emoji: "✨" },
];
// Cumulative thresholds for weighted roll
const BEE_THRESHOLDS = (() => {
  let acc = 0;
  return BEES.map(b => { acc += b.chance; return { ...b, threshold: acc }; });
})();

function rollBee() {
  const r = Math.random() * 100;
  return BEE_THRESHOLDS.find(b => r < b.threshold);
}
function getBeeByName(name) {
  return BEES.find(b => b.name.toLowerCase() === name.toLowerCase());
}

// bee_data.json: { userId: { bees: [{name,pollen,emoji}], pollen: N, honey: N, lastCollect: ISO } }
let beeData = loadJSON(BEE_FILE, {});

function getBeeUser(userId) {
  if (!beeData[userId]) beeData[userId] = { bees: [], pollen: 0, honey: 0, lastCollect: null };
  return beeData[userId];
}
function saveBeeData() { saveJSON(BEE_FILE, beeData); }

// Collect pollen for a user based on elapsed hours since lastCollect
function collectPollen(userId) {
  const u = getBeeUser(userId);
  if (!u.bees.length) return 0;
  const now = Date.now();
  const last = u.lastCollect ? new Date(u.lastCollect).getTime() : now;
  const hoursElapsed = Math.floor((now - last) / 3600000);
  if (hoursElapsed <= 0) return 0;
  const pollenPerHour = u.bees.reduce((sum, b) => {
    const bee = BEES.find(x => x.name === b.name);
    return sum + (bee ? bee.pollen : 0);
  }, 0);
  const gained = pollenPerHour * hoursElapsed;
  u.pollen += gained;
  u.lastCollect = new Date(now).toISOString();
  saveBeeData();
  return gained;
}

// Auto-collect interval: every hour collect for all users
setInterval(() => {
  beeData = loadJSON(BEE_FILE, {});
  for (const uid of Object.keys(beeData)) collectPollen(uid);
}, 3600000);

// ─── PACK REGISTRY ─────────────────────────────────────────────────────────────
// Паки — встроенные наборы команд. Список паков жёстко задан в коде.
// !dw_pack подключает пак (A+), /l_pack показывает активные паки.
const PACK_REGISTRY = {
  bee: {
    description: "Пчелиный пак — собирай пчёл, пыльцу и мёд!",
    commands: [
      { name: "!roll_bee",                    description: "Получить случайную пчелу" },
      { name: "!pollen",                      description: "Посмотреть свою пыльцу" },
      { name: "!honey",                       description: "Посмотреть свой мёд" },
      { name: "!convert",                     description: "Конвертировать пыльцу в мёд (2 пыльцы = 1 мёд)" },
      { name: "!top_bee",                     description: "Топ мёда на сервере" },
      { name: "!get_bee <пчела>",             description: "Получить пчелу себе [S]" },
      { name: "!give_bee [user] <пчела>",     description: "Дать пчелу пользователю [S]" },
      { name: "!get_honey [user] <кол-во>",   description: "Добавить мёд пользователю [S]" },
      { name: "!give_honey [user] <кол-во>",  description: "Забрать мёд у пользователя [S]" },
      { name: "!get_pollen [user] <кол-во>",  description: "Добавить пыльцу пользователю [S]" },
      { name: "!give_pollen [user] <кол-во>", description: "Забрать пыльцу у пользователя [S]" },
    ],
  },
};

// activePacks.json: ["bee", ...]
const ACTIVE_PACKS_FILE = "./active_packs.json";
let activePacks = loadJSON(ACTIVE_PACKS_FILE, []);
function saveActivePacks() { saveJSON(ACTIVE_PACKS_FILE, activePacks); }

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

// ─── SLASH COMMANDS ────────────────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName("l_pack")
    .setDescription("Показать список активных паков команд"),
].map(c => c.toJSON());

client.once("ready", async () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log("✅ Slash-команды зарегистрированы");
  } catch (e) { console.error(e); }
});

// ─── SLASH / BUTTON INTERACTIONS ───────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // /l_pack
  if (interaction.isChatInputCommand() && interaction.commandName === "l_pack") {
    activePacks = loadJSON(ACTIVE_PACKS_FILE, []);
    if (activePacks.length === 0)
      return interaction.reply({ content: "📦 Активных паков нет. Подключи через `!dw_pack <название>`.", ephemeral: true });

    const rows = [];
    let row = new ActionRowBuilder();
    activePacks.forEach((name, i) => {
      if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
      row.addComponents(new ButtonBuilder()
        .setCustomId(`pack_view:${name}`)
        .setLabel(`📦 ${name}`)
        .setStyle(ButtonStyle.Primary));
    });
    rows.push(row);

    const embed = new EmbedBuilder()
      .setTitle("📦 Активные паки")
      .setDescription("Нажми на кнопку, чтобы посмотреть команды пака")
      .setColor(0x5865f2);
    return interaction.reply({ embeds: [embed], components: rows });
  }

  // Button: pack_view:<name>
  if (interaction.isButton() && interaction.customId.startsWith("pack_view:")) {
    const packName = interaction.customId.slice("pack_view:".length);
    const pack = PACK_REGISTRY[packName];
    if (!pack) return interaction.reply({ content: "❌ Пак не найден.", ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle(`📦 Пак: ${packName}`)
      .setDescription(pack.description)
      .setColor(0x57f287)
      .addFields({
        name: "Команды",
        value: pack.commands.map(c => `**${c.name}** — ${c.description}`).join("\n"),
      });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ─── PREFIX COMMANDS ───────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;

  const args   = message.content.slice(1).trim().split(/\s+/);
  const cmd    = args.shift().toLowerCase();
  const authorId   = message.author.id;

  // ── Утилита: получить целевого участника ─────────────────────────────────────
  async function resolveTarget(argIdx = 0) {
    if (message.reference) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        return ref.member || await message.guild.members.fetch(ref.author.id).catch(() => null);
      } catch { return null; }
    }
    const raw = args[argIdx];
    if (!raw) return null;
    const id = raw.replace(/[<@!>]/g, "");
    return message.guild.members.fetch(id).catch(() => null);
  }

  // ── Утилита: resolveTarget но без reply-логики (всегда по аргументу) ─────────
  async function resolveArgTarget(argIdx = 0) {
    const raw = args[argIdx];
    if (!raw) return null;
    const id = raw.replace(/[<@!>]/g, "");
    return message.guild.members.fetch(id).catch(() => null);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // МОДЕРАЦИЯ (B+)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "mute") {
    if (!hasRank(authorId, "B")) return message.reply("❌ Нужен ранг **B** или выше.");
    let target, timeStr, reason;
    if (message.reference) {
      target  = await resolveTarget();
      timeStr = args[0];
      reason  = args.slice(1).join(" ") || "Не указана";
    } else {
      target  = await resolveTarget(0);
      timeStr = args[1];
      reason  = args.slice(2).join(" ") || "Не указана";
    }
    if (!target) return message.reply("❌ Пользователь не найден.");
    const ms = parseTime(timeStr);
    if (!ms) return message.reply("❌ Укажи время: `1h30m`, `45m`, `90s`");
    try {
      await target.timeout(ms, reason);
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🔇 Мут выдан").setColor(0xfee75c)
        .addFields({ name: "Пользователь", value: target.user.tag, inline: true },
                   { name: "Время",        value: formatTime(ms),  inline: true },
                   { name: "Причина",      value: reason })] });
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  if (cmd === "ban") {
    if (!hasRank(authorId, "B")) return message.reply("❌ Нужен ранг **B** или выше.");
    let target, reason;
    if (message.reference) { target = await resolveTarget(); reason = args.join(" ") || "Не указана"; }
    else { target = await resolveTarget(0); reason = args.slice(1).join(" ") || "Не указана"; }
    if (!target) return message.reply("❌ Пользователь не найден.");
    try {
      await target.ban({ reason });
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🔨 Бан выдан").setColor(0xed4245)
        .addFields({ name: "Пользователь", value: target.user.tag, inline: true },
                   { name: "Причина",      value: reason })] });
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  if (cmd === "kick") {
    if (!hasRank(authorId, "B")) return message.reply("❌ Нужен ранг **B** или выше.");
    let target, reason;
    if (message.reference) { target = await resolveTarget(); reason = args.join(" ") || "Не указана"; }
    else { target = await resolveTarget(0); reason = args.slice(1).join(" ") || "Не указана"; }
    if (!target) return message.reply("❌ Пользователь не найден.");
    try {
      await target.kick(reason);
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle("👢 Кик выдан").setColor(0xe67e22)
        .addFields({ name: "Пользователь", value: target.user.tag, inline: true },
                   { name: "Причина",      value: reason })] });
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // РАНГИ (A+)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "up") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");
    const tid = target.user.id;
    const cur = getRank(tid);
    const nxt = rankUpOf(cur);
    if (!nxt) return message.reply(`❌ **${target.user.tag}** уже максимальный ранг **${cur}**.`);
    if (!hasRank(authorId, "S") && rankIndex(nxt) > rankIndex("A"))
      return message.reply("❌ Ранг **A** может повышать максимум до **A**.");
    setRank(tid, nxt);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("⬆️ Ранг повышен").setColor(0x57f287)
      .setDescription(`**${target.user.tag}**: **${cur}** → **${nxt}**`)] });
  }

  if (cmd === "down") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");
    const tid = target.user.id;
    if (getRank(tid) === "S" && !hasRank(authorId, "S"))
      return message.reply("❌ Нельзя понижать **S** ранг.");
    const cur = getRank(tid);
    const prv = rankDownOf(cur);
    if (!prv) return message.reply(`❌ **${target.user.tag}** уже минимальный ранг **${cur}**.`);
    setRank(tid, prv);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("⬇️ Ранг понижен").setColor(0xed4245)
      .setDescription(`**${target.user.tag}**: **${cur}** → **${prv}**`)] });
  }

  // !set_rank [user] <ранг>
  if (cmd === "set_rank") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");

    let target, rankArg;
    if (message.reference) {
      target  = await resolveTarget();
      rankArg = args[0]?.toUpperCase();
    } else {
      target  = await resolveTarget(0);
      rankArg = args[1]?.toUpperCase();
    }

    if (!target) return message.reply("❌ Пользователь не найден.");
    if (!rankArg || !RANK_ORDER.includes(rankArg))
      return message.reply(`❌ Укажи ранг: ${RANK_ORDER.join(", ")}`);

    const tid = target.user.id;
    // A может ставить только до A
    if (!hasRank(authorId, "S") && rankIndex(rankArg) > rankIndex("A"))
      return message.reply("❌ Ранг **A** может устанавливать максимум ранг **A**.");
    // Нельзя трогать S без S
    if (getRank(tid) === "S" && !hasRank(authorId, "S"))
      return message.reply("❌ Нельзя изменять ранг **S** пользователя.");

    const old = getRank(tid);
    setRank(tid, rankArg);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🎖️ Ранг установлен").setColor(0x5865f2)
      .setDescription(`**${target.user.tag}**: **${old}** → **${rankArg}**`)] });
  }

  if (cmd === "lrangs") {
    ranks = loadJSON(RANKS_FILE, {});
    const grouped = {};
    for (const r of RANK_ORDER) grouped[r] = [];
    grouped["S"].push(ADMIN_ID);
    for (const [uid, r] of Object.entries(ranks)) {
      if (uid === ADMIN_ID) continue;
      if (grouped[r]) grouped[r].push(uid);
    }
    const lines = [];
    for (const r of [...RANK_ORDER].reverse()) {
      if (!grouped[r].length) continue;
      lines.push(`**${r} ранг:** ${grouped[r].map(id => `<@${id}>`).join(", ")}`);
    }
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏅 Список рангов")
      .setColor(0x5865f2).setDescription(lines.join("\n") || "Никого нет")] });
  }

  if (cmd === "myrank") {
    return message.reply(`🏅 Твой ранг: **${getRank(authorId)}**`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ПАКИ — УПРАВЛЕНИЕ (A+)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "dw_pack") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const packName = args[0]?.toLowerCase();
    if (!packName) return message.reply("❌ Укажи название пака: `!dw_pack <название>`");
    if (!PACK_REGISTRY[packName]) return message.reply(`❌ Пак **${packName}** не существует. Доступные паки: ${Object.keys(PACK_REGISTRY).join(", ")}`);
    activePacks = loadJSON(ACTIVE_PACKS_FILE, []);
    if (activePacks.includes(packName)) return message.reply(`⚠️ Пак **${packName}** уже подключён.`);
    activePacks.push(packName);
    saveActivePacks();
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("📦 Пак подключён").setColor(0x57f287)
      .setDescription(`Пак **${packName}** активирован! Используй \`/l_pack\` чтобы посмотреть команды.`)] });
  }

  if (cmd === "rm_pack") {
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    const packName = args[0]?.toLowerCase();
    if (!packName) return message.reply("❌ Укажи название пака: `!rm_pack <название>`");
    activePacks = loadJSON(ACTIVE_PACKS_FILE, []);
    if (!activePacks.includes(packName)) return message.reply(`❌ Пак **${packName}** не подключён.`);
    activePacks = activePacks.filter(p => p !== packName);
    saveActivePacks();
    return message.reply(`🗑️ Пак **${packName}** отключён.`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ПАК: BEE
  // ═══════════════════════════════════════════════════════════════════════════════

  const beePack = () => {
    activePacks = loadJSON(ACTIVE_PACKS_FILE, []);
    return activePacks.includes("bee");
  };

  // !roll_bee
  if (cmd === "roll_bee") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const bee = rollBee();
    const u = getBeeUser(authorId);
    if (!u.lastCollect) u.lastCollect = new Date().toISOString();
    u.bees.push({ name: bee.name, emoji: bee.emoji });
    saveBeeData();
    const rarity = bee.chance >= 20 ? "Обычная" : bee.chance >= 5 ? "Редкая" : bee.chance >= 1 ? "Эпическая" : "Легендарная";
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle(`${bee.emoji} Ты получил: ${bee.name}!`)
      .setColor(bee.chance >= 20 ? 0xfee75c : bee.chance >= 5 ? 0x57f287 : bee.chance >= 1 ? 0x9b59b6 : 0xe74c3c)
      .addFields(
        { name: "Редкость",   value: rarity,                       inline: true },
        { name: "Шанс",       value: `${bee.chance}%`,             inline: true },
        { name: "Пыльца/час", value: `${bee.pollen} 🌸`,           inline: true },
        { name: "Всего пчёл", value: `${u.bees.length}`,           inline: true },
      )] });
  }

  // !pollen
  if (cmd === "pollen") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const gained = collectPollen(authorId);
    const u = getBeeUser(authorId);
    const perHour = u.bees.reduce((s, b) => { const bee = BEES.find(x => x.name===b.name); return s+(bee?bee.pollen:0); }, 0);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🌸 Пыльца").setColor(0xf1c40f)
      .setDescription(`У **${message.author.username}**`)
      .addFields(
        { name: "Пыльца",       value: `${u.pollen} 🌸`,  inline: true },
        { name: "Пыльца/час",   value: `${perHour} 🌸`,   inline: true },
        { name: "Пчёл",         value: `${u.bees.length}`, inline: true },
        ...(gained ? [{ name: "Собрано сейчас", value: `+${gained} 🌸` }] : []),
      )] });
  }

  // !honey
  if (cmd === "honey") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(authorId);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🍯 Мёд").setColor(0xe67e22)
      .setDescription(`У **${message.author.username}**: **${u.honey}** 🍯`)] });
  }

  // !convert [кол-во пыльцы]
  if (cmd === "convert") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    collectPollen(authorId);
    const u = getBeeUser(authorId);
    const amount = args[0] ? parseInt(args[0]) : u.pollen;
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество пыльцы для конвертации.");
    const usable = Math.floor(amount / 2) * 2;
    if (usable < 2) return message.reply("❌ Нужно минимум **2 пыльцы** для конвертации.");
    if (u.pollen < usable) return message.reply(`❌ Недостаточно пыльцы. У тебя: **${u.pollen}** 🌸`);
    const honeyGained = usable / 2;
    u.pollen -= usable;
    u.honey  += honeyGained;
    saveBeeData();
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🍯 Конвертация").setColor(0xe67e22)
      .addFields(
        { name: "Потрачено пыльцы", value: `${usable} 🌸`,     inline: true },
        { name: "Получено мёда",    value: `${honeyGained} 🍯`, inline: true },
        { name: "Остаток пыльцы",   value: `${u.pollen} 🌸`,   inline: true },
        { name: "Всего мёда",       value: `${u.honey} 🍯`,     inline: true },
      )] });
  }

  // !top_bee
  if (cmd === "top_bee") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const sorted = Object.entries(beeData)
      .map(([uid, d]) => ({ uid, honey: d.honey || 0 }))
      .sort((a, b) => b.honey - a.honey)
      .slice(0, 10);
    if (!sorted.length) return message.reply("📊 Пока никто не собрал мёд.");
    const medals = ["🥇","🥈","🥉"];
    const lines = sorted.map((e, i) => `${medals[i]||`${i+1}.`} <@${e.uid}> — **${e.honey}** 🍯`);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏆 Топ мёда").setColor(0xf1c40f)
      .setDescription(lines.join("\n"))] });
  }

  // ── S-ранг: bee admin commands ────────────────────────────────────────────────

  // !get_bee <пчела> — дать себе
  if (cmd === "get_bee") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    const beeName = args.join(" ");
    const bee = getBeeByName(beeName);
    if (!bee) return message.reply(`❌ Пчела **${beeName}** не найдена. Доступны: ${BEES.map(b=>b.name).join(", ")}`);
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(authorId);
    u.bees.push({ name: bee.name, emoji: bee.emoji });
    saveBeeData();
    return message.reply(`✅ Ты получил **${bee.emoji} ${bee.name}**!`);
  }

  // !give_bee [user] <пчела>
  if (cmd === "give_bee") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, beeName;
    if (message.reference) {
      target  = await resolveTarget();
      beeName = args.join(" ");
    } else {
      target  = await resolveTarget(0);
      beeName = args.slice(1).join(" ");
    }
    if (!target) return message.reply("❌ Пользователь не найден.");
    const bee = getBeeByName(beeName);
    if (!bee) return message.reply(`❌ Пчела не найдена. Доступны: ${BEES.map(b=>b.name).join(", ")}`);
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    u.bees.push({ name: bee.name, emoji: bee.emoji });
    saveBeeData();
    return message.reply(`✅ **${target.user.tag}** получил **${bee.emoji} ${bee.name}**!`);
  }

  // !get_honey [user] <кол-во> — добавить мёд
  if (cmd === "get_honey") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, amount;
    if (message.reference) { target = await resolveTarget(); amount = parseInt(args[0]); }
    else { target = await resolveTarget(0); amount = parseInt(args[1]); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество.");
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    u.honey += amount; saveBeeData();
    return message.reply(`✅ **${target.user.tag}** +${amount} 🍯 (теперь: ${u.honey})`);
  }

  // !give_honey [user] <кол-во> — забрать мёд
  if (cmd === "give_honey") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, amount;
    if (message.reference) { target = await resolveTarget(); amount = parseInt(args[0]); }
    else { target = await resolveTarget(0); amount = parseInt(args[1]); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество.");
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    u.honey = Math.max(0, u.honey - amount); saveBeeData();
    return message.reply(`✅ **${target.user.tag}** -${amount} 🍯 (теперь: ${u.honey})`);
  }

  // !get_pollen [user] <кол-во> — добавить пыльцу
  if (cmd === "get_pollen") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, amount;
    if (message.reference) { target = await resolveTarget(); amount = parseInt(args[0]); }
    else { target = await resolveTarget(0); amount = parseInt(args[1]); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество.");
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    u.pollen += amount; saveBeeData();
    return message.reply(`✅ **${target.user.tag}** +${amount} 🌸 (теперь: ${u.pollen})`);
  }

  // !give_pollen [user] <кол-во> — забрать пыльцу
  if (cmd === "give_pollen") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, amount;
    if (message.reference) { target = await resolveTarget(); amount = parseInt(args[0]); }
    else { target = await resolveTarget(0); amount = parseInt(args[1]); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество.");
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    u.pollen = Math.max(0, u.pollen - amount); saveBeeData();
    return message.reply(`✅ **${target.user.tag}** -${amount} 🌸 (теперь: ${u.pollen})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // !im <слово>
  // ═══════════════════════════════════════════════════════════════════════════════
  if (cmd === "im") {
    const word = args.join(" ");
    if (!word) return message.reply("❌ Напиши слово: `!im <слово>`");
    const percent = (Math.random() * 99.99 + 0.01).toFixed(2);
    return message.reply(`**${message.author.username}** на **${percent}%** ${word}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // !help
  // ═══════════════════════════════════════════════════════════════════════════════
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📋 Команды бота")
      .setColor(0x5865f2)
      .addFields(
        { name: "👮 Модерация (B+)",
          value: ["`!mute [user] [время] [причина]`","`!ban [user] [причина]`","`!kick [user] [причина]`"].join("\n") },
        { name: "🏅 Ранги (A+)",
          value: ["`!up [user]`","`!down [user]`","`!set_rank [user] <ранг>`","`!lrangs`","`!myrank`"].join("\n") },
        { name: "📦 Паки (A+)",
          value: ["`!dw_pack <название>` — подключить пак","`!rm_pack <название>` — отключить [S]","`/l_pack` — список активных паков"].join("\n") },
        { name: "🐝 Пак Bee (все)",
          value: ["`!roll_bee`","`!pollen`","`!honey`","`!convert [кол-во]`","`!top_bee`"].join("\n") },
        { name: "🎲 Разное",
          value: ["`!im <слово>` — узнать на сколько % ты что-то"].join("\n") },
      )
      .setFooter({ text: "[user] можно заменить ответом на сообщение" });
    return message.channel.send({ embeds: [embed] });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
client.login(TOKEN);
