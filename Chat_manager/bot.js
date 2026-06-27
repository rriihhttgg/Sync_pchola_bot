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
const CAT_FILE   = "./cat_data.json";

function loadJSON(file, def) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(def, null, 2));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let ranks = loadJSON(RANKS_FILE, {});

// ─── RANK SYSTEM ───────────────────────────────────────────────────────────────
// cat — специальный ранг пака, не входит в основную лестницу
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
// cat-ранг: отдельная проверка
function hasCatRank(userId)      { return ranks[userId] === "cat" || hasRank(userId, "S"); }
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
const BEES = [
  { name: "Bee",       chance: 40,   pollen: 1,    emoji: "🐝" },
  { name: "Honey bee", chance: 30,   pollen: 3,    emoji: "🍯" },
  { name: "Fuzzy bee", chance: 20,   pollen: 5,    emoji: "🟡" },
  { name: "Shy bee",   chance: 7,    pollen: 15,   emoji: "😳" },
  { name: "Cute bee",  chance: 2.5,  pollen: 35,   emoji: "🥰" },
  { name: "Queen bee", chance: 0.49, pollen: 150,  emoji: "👑" },
  { name: "Riht bee",  chance: 0.01, pollen: 2500, emoji: "✨" },
];
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

let beeData = loadJSON(BEE_FILE, {});

function getBeeUser(userId) {
  if (!beeData[userId]) beeData[userId] = { bees: [], pollen: 0, honey: 0, lastCollect: null };
  return beeData[userId];
}
function saveBeeData() { saveJSON(BEE_FILE, beeData); }

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

setInterval(() => {
  beeData = loadJSON(BEE_FILE, {});
  for (const uid of Object.keys(beeData)) collectPollen(uid);
}, 3600000);

// ─── CAT PACK ──────────────────────────────────────────────────────────────────
let catData = loadJSON(CAT_FILE, {});
function saveCatData() { saveJSON(CAT_FILE, catData); }

// Получить случайные картинки котов через The Cat API (публичный, без ключа)
async function fetchCatImages(count) {
  const urls = [];
  try {
    const res = await fetch(`https://api.thecatapi.com/v1/images/search?limit=${count}`);
    const data = await res.json();
    for (const item of data) urls.push(item.url);
  } catch {
    // fallback: placecats
    for (let i = 0; i < count; i++) {
      const w = 300 + Math.floor(Math.random()*200);
      const h = 200 + Math.floor(Math.random()*200);
      urls.push(`https://placecats.com/${w}/${h}`);
    }
  }
  return urls;
}

// ─── PACK REGISTRY ─────────────────────────────────────────────────────────────
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
  cat: {
    description: "Кошачий пак — получи ранг cat и терроризируй сервер!",
    commands: [
      { name: "!cat_raid",              description: "Отправить 3–10 рандомных котов [cat]" },
      { name: "!bite [user]",           description: "Укусить пользователя [cat]" },
      { name: "!claw [user]",           description: "Поцарапать пользователя [cat]" },
      { name: "!lick [user]",           description: "Облизать пользователя [cat]" },
      { name: "!piss [user]",           description: "Пописать на пользователя (не работает на S) [cat]" },
      { name: "!pet [user с рангом cat]",   description: "Погладить кота [все]" },
      { name: "!smack [user с рангом cat]", description: "Чмокнуть кота [все]" },
    ],
  },
};

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

  const args     = message.content.slice(1).trim().split(/\s+/);
  const cmd      = args.shift().toLowerCase();
  const authorId = message.author.id;

  // ── Авто-ранг для владельца сервера ──────────────────────────────────────────
  // Если у владельца ранг ниже A — ставим A при каждом сообщении
  if (message.guild && message.guild.ownerId === authorId) {
    const ownerRank = getRank(authorId);
    if (ownerRank !== "S" && rankIndex(ownerRank) < rankIndex("A")) {
      setRank(authorId, "A");
    }
  }

  // ── Утилита: resolveTarget ────────────────────────────────────────────────────
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

  async function resolveArgTarget(argIdx = 0) {
    const raw = args[argIdx];
    if (!raw) return null;
    const id = raw.replace(/[<@!>]/g, "");
    return message.guild.members.fetch(id).catch(() => null);
  }

  // ── Проверка активности паков ─────────────────────────────────────────────────
  const beePack = () => { activePacks = loadJSON(ACTIVE_PACKS_FILE, []); return activePacks.includes("bee"); };
  const catPack = () => { activePacks = loadJSON(ACTIVE_PACKS_FILE, []); return activePacks.includes("cat"); };

  // ═══════════════════════════════════════════════════════════════════════════════
  // МОДЕРАЦИЯ (B+)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "mute") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
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

  if (cmd === "unmute") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");
    try {
      await target.timeout(null);
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🔊 Мут снят").setColor(0x57f287)
        .addFields({ name: "Пользователь", value: target.user.tag })] });
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  if (cmd === "ban") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
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

  if (cmd === "unban") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
    // unban работает только по ID, т.к. забаненного нельзя fetch как member
    let userId;
    if (message.reference) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        userId = ref.author.id;
      } catch { return message.reply("❌ Не удалось получить пользователя из ответа."); }
    } else {
      const raw = args[0];
      if (!raw) return message.reply("❌ Укажи ID пользователя или ответь на его сообщение.");
      userId = raw.replace(/[<@!>]/g, "");
    }
    try {
      const banned = await message.guild.bans.fetch(userId).catch(() => null);
      if (!banned) return message.reply("❌ Этот пользователь не забанен.");
      await message.guild.members.unban(userId);
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle("✅ Бан снят").setColor(0x57f287)
        .addFields({ name: "Пользователь", value: `<@${userId}> (${userId})` })] });
    } catch (e) { return message.reply(`❌ ${e.message}`); }
  }

  if (cmd === "kick") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
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
    if (cur === "cat") return message.reply("❌ Нельзя повышать ранг **cat** через `!up`. Используй `!set_rank`.");
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
    if (getRank(tid) === "cat") return message.reply("❌ Нельзя понижать ранг **cat** через `!down`. Используй `!set_rank`.");
    const cur = getRank(tid);
    const prv = rankDownOf(cur);
    if (!prv) return message.reply(`❌ **${target.user.tag}** уже минимальный ранг **${cur}**.`);
    setRank(tid, prv);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("⬇️ Ранг понижен").setColor(0xed4245)
      .setDescription(`**${target.user.tag}**: **${cur}** → **${prv}**`)] });
  }

  if (cmd === "set_rank") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");

    let target, rankArg;
    if (message.reference) {
      target  = await resolveTarget();
      rankArg = args[0]?.toLowerCase();
    } else {
      target  = await resolveTarget(0);
      rankArg = args[1]?.toLowerCase();
    }

    if (!target) return message.reply("❌ Пользователь не найден.");

    const rankArgUp = rankArg?.toUpperCase();
    const validRanks = [...RANK_ORDER.map(r => r.toLowerCase()), "cat"];
    if (!rankArg || !validRanks.includes(rankArg))
      return message.reply(`❌ Укажи ранг: ${RANK_ORDER.join(", ")}, cat`);

    const tid = target.user.id;

    // cat-ранг может выдавать только S
    if (rankArg === "cat" && !hasRank(authorId, "S"))
      return message.reply("❌ Только **S** ранг может выдавать ранг **cat**.");

    // A может ставить только до A
    if (rankArg !== "cat" && !hasRank(authorId, "S") && rankIndex(rankArgUp) > rankIndex("A"))
      return message.reply("❌ Ранг **A** может устанавливать максимум ранг **A**.");

    if (getRank(tid) === "S" && !hasRank(authorId, "S"))
      return message.reply("❌ Нельзя изменять ранг **S** пользователя.");

    const old = getRank(tid);
    const newRank = rankArg === "cat" ? "cat" : rankArgUp;
    setRank(tid, newRank);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🎖️ Ранг установлен").setColor(0x5865f2)
      .setDescription(`**${target.user.tag}**: **${old}** → **${newRank}**`)] });
  }

  if (cmd === "lrangs") {
    ranks = loadJSON(RANKS_FILE, {});
    const grouped = {};
    for (const r of RANK_ORDER) grouped[r] = [];
    grouped["cat"] = [];
    grouped["S"].push(ADMIN_ID);
    for (const [uid, r] of Object.entries(ranks)) {
      if (uid === ADMIN_ID) continue;
      if (grouped[r] !== undefined) grouped[r].push(uid);
    }
    const lines = [];
    for (const r of [...RANK_ORDER].reverse()) {
      if (!grouped[r].length) continue;
      lines.push(`**${r} ранг:** ${grouped[r].map(id => `<@${id}>`).join(", ")}`);
    }
    if (grouped["cat"].length)
      lines.push(`**🐱 cat ранг:** ${grouped["cat"].map(id => `<@${id}>`).join(", ")}`);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏅 Список рангов")
      .setColor(0x5865f2).setDescription(lines.join("\n") || "Никого нет")] });
  }

  if (cmd === "myrank") {
    const r = getRank(authorId);
    const display = r === "cat" ? "🐱 cat" : r;
    return message.reply(`🏅 Твой ранг: **${display}**`);
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

  if (cmd === "roll_bee") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(authorId);
    const ROLL_COOLDOWN = 3600000;
    const now = Date.now();
    const lastRoll = u.lastRoll ? new Date(u.lastRoll).getTime() : 0;
    const elapsed = now - lastRoll;
    if (elapsed < ROLL_COOLDOWN) {
      const remaining = ROLL_COOLDOWN - elapsed;
      const mm = Math.floor(remaining / 60000);
      const ss = Math.floor((remaining % 60000) / 1000);
      return message.reply(`⏳ Следующий ролл через **${mm}м ${ss}с**`);
    }
    const bee = rollBee();
    if (!u.lastCollect) u.lastCollect = new Date(now).toISOString();
    u.lastRoll = new Date(now).toISOString();
    u.bees.push({ name: bee.name, emoji: bee.emoji });
    saveBeeData();
    const rarity = bee.chance >= 20 ? "Обычная" : bee.chance >= 5 ? "Редкая" : bee.chance >= 1 ? "Эпическая" : "Легендарная";
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle(`${bee.emoji} Ты получил: ${bee.name}!`)
      .setColor(bee.chance >= 20 ? 0xfee75c : bee.chance >= 5 ? 0x57f287 : bee.chance >= 1 ? 0x9b59b6 : 0xe74c3c)
      .addFields(
        { name: "Редкость",   value: rarity,            inline: true },
        { name: "Шанс",       value: `${bee.chance}%`,  inline: true },
        { name: "Пыльца/час", value: `${bee.pollen} 🌸`, inline: true },
        { name: "Всего пчёл", value: `${u.bees.length}`, inline: true },
      )] });
  }

  if (cmd === "pollen") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const gained = collectPollen(authorId);
    const u = getBeeUser(authorId);
    const perHour = u.bees.reduce((s, b) => { const bee = BEES.find(x => x.name===b.name); return s+(bee?bee.pollen:0); }, 0);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🌸 Пыльца").setColor(0xf1c40f)
      .setDescription(`У **${message.author.username}**`)
      .addFields(
        { name: "Пыльца",     value: `${u.pollen} 🌸`,  inline: true },
        { name: "Пыльца/час", value: `${perHour} 🌸`,   inline: true },
        { name: "Пчёл",       value: `${u.bees.length}`, inline: true },
        ...(gained ? [{ name: "Собрано сейчас", value: `+${gained} 🌸` }] : []),
      )] });
  }

  if (cmd === "honey") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(authorId);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🍯 Мёд").setColor(0xe67e22)
      .setDescription(`У **${message.author.username}**: **${u.honey}** 🍯`)] });
  }

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

  // ── Bee S-ранг ────────────────────────────────────────────────────────────────

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

  if (cmd === "give_bee") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, beeName;
    if (message.reference) { target = await resolveTarget(); beeName = args.join(" "); }
    else { target = await resolveTarget(0); beeName = args.slice(1).join(" "); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    const bee = getBeeByName(beeName);
    if (!bee) return message.reply(`❌ Пчела не найдена. Доступны: ${BEES.map(b=>b.name).join(", ")}`);
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    u.bees.push({ name: bee.name, emoji: bee.emoji });
    saveBeeData();
    return message.reply(`✅ **${target.user.tag}** получил **${bee.emoji} ${bee.name}**!`);
  }

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
  // ПАК: CAT
  // ═══════════════════════════════════════════════════════════════════════════════

  // !cat_raid — только cat-ранг
  if (cmd === "cat_raid") {
    if (!catPack()) return;
    if (!hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const count = Math.floor(Math.random() * 8) + 3; // 3–10
    await message.channel.send(`🐱 **КОТ-РЕЙД!** Летит **${count}** котов!`);
    const urls = await fetchCatImages(count);
    for (const url of urls) {
      await message.channel.send({ embeds: [new EmbedBuilder().setImage(url).setColor(0xff69b4)] });
    }
    return;
  }

  // !bite [user]
  if (cmd === "bite") {
    if (!catPack()) return;
    if (!hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("😼 Укус!")
      .setDescription(`**${message.author.username}** укусил **${target.user.username}**! 🦷`)
      .setColor(0xff4444)] });
  }

  // !claw [user]
  if (cmd === "claw") {
    if (!catPack()) return;
    if (!hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("🐾 Царапина!")
      .setDescription(`**${message.author.username}** поцарапал **${target.user.username}**! 🩸`)
      .setColor(0xff8800)] });
  }

  // !lick [user]
  if (cmd === "lick") {
    if (!catPack()) return;
    if (!hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("👅 Облизывание!")
      .setDescription(`**${message.author.username}** облизал **${target.user.username}**! 😹`)
      .setColor(0xffccdd)] });
  }

  // !piss [user] — не работает на S
  if (cmd === "piss") {
    if (!catPack()) return;
    if (!hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    if (hasRank(target.user.id, "S"))
      return message.reply("❌ Нельзя пописать на **S** ранг! Они слишком могущественны. 😤");
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("💦 Территория помечена!")
      .setDescription(`**${message.author.username}** пописал на **${target.user.username}**! 💛`)
      .setColor(0xffff00)] });
  }

  // !pet [user с рангом cat] — для всех
  if (cmd === "pet") {
    if (!catPack()) return;
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    if (!hasCatRank(target.user.id))
      return message.reply(`❌ **${target.user.username}** не является котом. Гладить можно только котов! 🐱`);
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("🐱 Гладим кота!")
      .setDescription(`**${message.author.username}** гладит **${target.user.username}**! 😻`)
      .setColor(0xffccff)] });
  }

  // !smack [user с рангом cat] — для всех
  if (cmd === "smack") {
    if (!catPack()) return;
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    if (!hasCatRank(target.user.id))
      return message.reply(`❌ **${target.user.username}** не является котом. Чмокать можно только котов! 🐱`);
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("😘 Чмок!")
      .setDescription(`**${message.author.username}** чмокнул **${target.user.username}**! 💋`)
      .setColor(0xff99cc)] });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // !im
  // ═══════════════════════════════════════════════════════════════════════════════
  if (cmd === "im") {
    const word = args.join(" ");
    if (!word) return message.reply("❌ Напиши слово: `!im <слово>`");
    const percent = (Math.random() * 99.99 + 0.01).toFixed(2);
    return message.reply(`**${message.author.username}** на **${percent}%** ${word}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HELP
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("📋 Команды бота")
      .setColor(0x5865f2)
      .addFields(
        { name: "👮 Модерация (B+)",
          value: [
            "`!mute [user] [время] [причина]`",
            "`!unmute [user]`",
            "`!ban [user] [причина]`",
            "`!unban [user/ID]`",
            "`!kick [user] [причина]`",
          ].join("\n") },
        { name: "🏅 Ранги (A+)",
          value: ["`!up [user]`","`!down [user]`","`!set_rank [user] <ранг>`","`!lrangs`","`!myrank`"].join("\n") },
        { name: "📦 Паки (A+)",
          value: [
            "`!dw_pack <название>` — подключить пак",
            "`!rm_pack <название>` — отключить [S]",
            "`/l_pack` — список активных паков",
          ].join("\n") },
        { name: "🎲 Разное",
          value: ["`!im <слово>` — узнать на сколько % ты что-то"].join("\n") },
        { name: "📖 Справка по пакам",
          value: ["`!help_bee` — команды пчелиного пака", "`!help_cat` — команды кошачьего пака"].join("\n") },
      )
      .setFooter({ text: "[user] можно заменить ответом на сообщение" });
    return message.channel.send({ embeds: [embed] });
  }

  if (cmd === "help_bee") {
    const embed = new EmbedBuilder()
      .setTitle("🐝 Пак Bee — команды")
      .setColor(0xf1c40f)
      .addFields(
        { name: "Для всех",
          value: [
            "`!roll_bee` — получить случайную пчелу (раз в час)",
            "`!pollen` — посмотреть пыльцу",
            "`!honey` — посмотреть мёд",
            "`!convert [кол-во]` — пыльца → мёд (2 🌸 = 1 🍯)",
            "`!top_bee` — топ-10 по мёду",
          ].join("\n") },
        { name: "S-ранг",
          value: [
            "`!get_bee <пчела>` — получить пчелу себе",
            "`!give_bee [user] <пчела>` — дать пчелу",
            "`!get_honey [user] <кол-во>` — добавить мёд",
            "`!give_honey [user] <кол-во>` — забрать мёд",
            "`!get_pollen [user] <кол-во>` — добавить пыльцу",
            "`!give_pollen [user] <кол-во>` — забрать пыльцу",
          ].join("\n") },
        { name: "Пчёлы и шансы",
          value: BEES.map(b => `${b.emoji} **${b.name}** — ${b.chance}% | ${b.pollen} пыльцы/ч`).join("\n") },
      )
      .setFooter({ text: "Пак подключается через !dw_pack bee" });
    return message.channel.send({ embeds: [embed] });
  }

  if (cmd === "help_cat") {
    const embed = new EmbedBuilder()
      .setTitle("🐱 Пак Cat — команды")
      .setColor(0xff69b4)
      .addFields(
        { name: "Для всех",
          value: [
            "`!pet [user с рангом cat]` — погладить кота",
            "`!smack [user с рангом cat]` — чмокнуть кота",
          ].join("\n") },
        { name: "Ранг cat (все команды ранга B+ плюс)",
          value: [
            "`!cat_raid` — отправить 3–10 рандомных котов",
            "`!bite [user]` — укусить пользователя",
            "`!claw [user]` — поцарапать пользователя",
            "`!lick [user]` — облизать пользователя",
            "`!piss [user]` — пописать на пользователя (не работает на S)",
          ].join("\n") },
        { name: "ℹ️ О ранге cat",
          value: "Ранг **cat** выдаётся только **S** рангом через `!set_rank [user] cat`.\nКоты также имеют доступ ко всем командам модерации (B+)." },
      )
      .setFooter({ text: "Пак подключается через !dw_pack cat" });
    return message.channel.send({ embeds: [embed] });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
client.login(TOKEN);
