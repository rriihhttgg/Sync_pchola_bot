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
  AttachmentBuilder,
} = require("discord.js");
const fs = require("fs");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

// ─── DATA FILES ────────────────────────────────────────────────────────────────
const RANKS_FILE     = "./ranks.json";
const BEE_FILE       = "./bee_data.json";
const CAT_FILE       = "./cat_data.json";
const RESPONSES_FILE = "./custom_responses.json";
const ACTIVE_PACKS_FILE = "./active_packs.json";

function loadJSON(file, def) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(def, null, 2));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let ranks           = loadJSON(RANKS_FILE, {});
let customResponses = loadJSON(RESPONSES_FILE, {});
let activePacks     = loadJSON(ACTIVE_PACKS_FILE, []);
let beeData         = loadJSON(BEE_FILE, {});
let catData         = loadJSON(CAT_FILE, {});

function saveResponses()   { saveJSON(RESPONSES_FILE, customResponses); }
function saveActivePacks() { saveJSON(ACTIVE_PACKS_FILE, activePacks); }
function saveBeeData()     { saveJSON(BEE_FILE, beeData); }
function saveCatData()     { saveJSON(CAT_FILE, catData); }

// ─── RANK SYSTEM ───────────────────────────────────────────────────────────────
const RANK_ORDER = ["F", "D", "C", "B", "A", "S"];

function getRank(userId) {
  if (userId === ADMIN_ID) return "S";
  return ranks[userId] ?? "F";
}
function setRank(userId, rank) { ranks[userId] = rank; saveJSON(RANKS_FILE, ranks); }
function rankIndex(r)          { return RANK_ORDER.indexOf(r); }
function hasRank(userId, minR) { return rankIndex(getRank(userId)) >= rankIndex(minR); }
function hasCatRank(userId)    { return ranks[userId] === "cat" || hasRank(userId, "S"); }
function rankUpOf(r)   { const i = rankIndex(r); return i < RANK_ORDER.length - 1 ? RANK_ORDER[i+1] : null; }
function rankDownOf(r) { const i = rankIndex(r); return i > 0 ? RANK_ORDER[i-1] : null; }

// ─── TIME HELPERS ──────────────────────────────────────────────────────────────
function parseTime(str) {
  if (!str) return null;
  let total = 0, found = false;
  const re = /(\d+)\s*([hHmMsS])/g; let m;
  while ((m = re.exec(str)) !== null) {
    found = true;
    const v = parseInt(m[1]), u = m[2].toLowerCase();
    if (u==="h") total += v*3600; else if (u==="m") total += v*60; else total += v;
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

// ─── CUSTOM RESPONSE SYSTEM ────────────────────────────────────────────────────
// Шаблонизатор: [1] = автор, [2] = цель, {percent}, {word}
function applyTemplate(tpl, author, target, extras = {}) {
  let out = tpl
    .replace(/\[1\]/g, author ? `<@${author.id}>` : "")
    .replace(/\[2\]/g, target ? `<@${target.id ?? target.user?.id}>` : "");
  for (const [k, v] of Object.entries(extras)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

// Для каждой команды определяем цвет и тайтл по умолчанию
const CMD_STYLES = {
  mute:        { color: 0xfee75c, title: "🔇 Мут выдан" },
  unmute:      { color: 0x57f287, title: "🔊 Мут снят" },
  ban:         { color: 0xed4245, title: "🔨 Бан выдан" },
  unban:       { color: 0x57f287, title: "✅ Бан снят" },
  kick:        { color: 0xe67e22, title: "👢 Кик выдан" },
  up:          { color: 0x57f287, title: "⬆️ Ранг повышен" },
  down:        { color: 0xed4245, title: "⬇️ Ранг понижен" },
  set_rank:    { color: 0x5865f2, title: "🎖️ Ранг установлен" },
  roll_bee:    { color: 0xfee75c, title: "🐝 Пчела получена" },
  pollen:      { color: 0xf1c40f, title: "🌸 Пыльца" },
  honey:       { color: 0xe67e22, title: "🍯 Мёд" },
  convert:     { color: 0xe67e22, title: "🍯 Конвертация" },
  top_bee:     { color: 0xf1c40f, title: "🏆 Топ мёда" },
  bite:        { color: 0xff4444, title: "😼 Укус!" },
  claw:        { color: 0xff8800, title: "🐾 Царапина!" },
  lick:        { color: 0xffccdd, title: "👅 Облизывание!" },
  piss:        { color: 0xffff00, title: "💦 Территория помечена!" },
  pet:         { color: 0xffccff, title: "🐱 Гладим кота!" },
  smack:       { color: 0xff99cc, title: "😘 Чмок!" },
  cat_raid:    { color: 0xff69b4, title: "🐱 КОТ-РЕЙД!" },
  im:          { color: 0x5865f2, title: null },
};

// Отправить ответ с кастомным шаблоном, оформленным как embed оригинала
function buildCustomEmbed(cmdKey, text) {
  const style = CMD_STYLES[cmdKey] ?? { color: 0x5865f2, title: null };
  const embed = new EmbedBuilder().setColor(style.color).setDescription(text);
  if (style.title) embed.setTitle(style.title);
  return embed;
}

// Получить кастомный ответ или null
function getCustomResponse(cmdKey) {
  customResponses = loadJSON(RESPONSES_FILE, {});
  return customResponses[cmdKey] ?? null;
}

// ─── CONFIG SNAPSHOT ───────────────────────────────────────────────────────────
function buildSnapshot() {
  return {
    savedAt:         new Date().toISOString(),
    ranks:           loadJSON(RANKS_FILE, {}),
    beeData:         loadJSON(BEE_FILE, {}),
    catData:         loadJSON(CAT_FILE, {}),
    activePacks:     loadJSON(ACTIVE_PACKS_FILE, []),
    customResponses: loadJSON(RESPONSES_FILE, {}),
  };
}

function applySnapshot(snap) {
  if (snap.ranks)           { saveJSON(RANKS_FILE, snap.ranks);           ranks           = snap.ranks; }
  if (snap.beeData)         { saveJSON(BEE_FILE, snap.beeData);           beeData         = snap.beeData; }
  if (snap.catData)         { saveJSON(CAT_FILE, snap.catData);           catData         = snap.catData; }
  if (snap.activePacks)     { saveJSON(ACTIVE_PACKS_FILE, snap.activePacks); activePacks  = snap.activePacks; }
  if (snap.customResponses) { saveJSON(RESPONSES_FILE, snap.customResponses); customResponses = snap.customResponses; }
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

function rollBee() { const r = Math.random()*100; return BEE_THRESHOLDS.find(b => r < b.threshold); }
function getBeeByName(name) { return BEES.find(b => b.name.toLowerCase() === name.toLowerCase()); }

function getBeeUser(userId) {
  if (!beeData[userId]) beeData[userId] = { bees: [], pollen: 0, honey: 0, lastCollect: null, lastRoll: null };
  return beeData[userId];
}

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
async function fetchCatImages(count) {
  const urls = [];
  try {
    const res = await fetch(`https://api.thecatapi.com/v1/images/search?limit=${count}`);
    const data = await res.json();
    for (const item of data) urls.push(item.url);
  } catch {
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
      { name: "!roll_bee",                    description: "Получить случайную пчелу (раз в час)" },
      { name: "!pollen",                      description: "Посмотреть свою пыльцу" },
      { name: "!honey",                       description: "Посмотреть свой мёд" },
      { name: "!convert [кол-во]",            description: "Конвертировать пыльцу в мёд (2 🌸 = 1 🍯)" },
      { name: "!top_bee",                     description: "Топ мёда на сервере" },
      { name: "!get_bee <пчела>",             description: "Получить пчелу себе [S]" },
      { name: "!give_bee [user] <пчела>",     description: "Дать пчелу пользователю [S]" },
      { name: "!get_honey [user] <кол-во>",   description: "Добавить мёд [S]" },
      { name: "!give_honey [user] <кол-во>",  description: "Забрать мёд [S]" },
      { name: "!get_pollen [user] <кол-во>",  description: "Добавить пыльцу [S]" },
      { name: "!give_pollen [user] <кол-во>", description: "Забрать пыльцу [S]" },
    ],
  },
  cat: {
    description: "Кошачий пак — получи ранг cat и терроризируй сервер!",
    commands: [
      { name: "!cat_raid",                      description: "Отправить 3–10 рандомных котов [cat]" },
      { name: "!bite [user]",                   description: "Укусить пользователя [cat]" },
      { name: "!claw [user]",                   description: "Поцарапать пользователя [cat]" },
      { name: "!lick [user]",                   description: "Облизать пользователя [cat]" },
      { name: "!piss [user]",                   description: "Пописать на пользователя (не работает на S) [cat]" },
      { name: "!pet [user с рангом cat]",       description: "Погладить кота [все]" },
      { name: "!smack [user с рангом cat]",     description: "Чмокнуть кота [все]" },
    ],
  },
};

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
const EDITABLE_CMDS = [
  "mute","unmute","ban","unban","kick",
  "up","down","set_rank","lrangs","myrank",
  "roll_bee","pollen","honey","convert","top_bee",
  "cat_raid","bite","claw","lick","piss","pet","smack","im",
];

const slashCommands = [
  new SlashCommandBuilder()
    .setName("l_pack")
    .setDescription("Показать список активных паков команд"),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Изменить ответ бота на команду [A+]")
    .addStringOption(o => o
      .setName("команда")
      .setDescription("Название команды без !, например: bite, im, roll_bee")
      .setRequired(true)
      .addChoices(...EDITABLE_CMDS.map(c => ({ name: c, value: c }))))
    .addStringOption(o => o
      .setName("ответ")
      .setDescription("Новый текст. [1] = автор, [2] = цель, {percent} и {word} для !im")
      .setRequired(true)),
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
    if (!activePacks.length)
      return interaction.reply({ content: "📦 Активных паков нет. Подключи через `!dw_pack <название>`.", ephemeral: true });
    const rows = [];
    let row = new ActionRowBuilder();
    activePacks.forEach((name, i) => {
      if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
      row.addComponents(new ButtonBuilder().setCustomId(`pack_view:${name}`).setLabel(`📦 ${name}`).setStyle(ButtonStyle.Primary));
    });
    rows.push(row);
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("📦 Активные паки").setDescription("Нажми на кнопку, чтобы посмотреть команды пака").setColor(0x5865f2)], components: rows });
  }

  // Button: pack_view
  if (interaction.isButton() && interaction.customId.startsWith("pack_view:")) {
    const packName = interaction.customId.slice("pack_view:".length);
    const pack = PACK_REGISTRY[packName];
    if (!pack) return interaction.reply({ content: "❌ Пак не найден.", ephemeral: true });
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle(`📦 Пак: ${packName}`)
      .setDescription(pack.description)
      .setColor(0x57f287)
      .addFields({ name: "Команды", value: pack.commands.map(c => `**${c.name}** — ${c.description}`).join("\n") })],
      ephemeral: true });
  }

  // /config
  if (interaction.isChatInputCommand() && interaction.commandName === "config") {
    if (!hasRank(interaction.user.id, "A"))
      return interaction.reply({ content: "❌ Нужен ранг **A** или выше.", ephemeral: true });

    const cmdName = interaction.options.getString("команда");
    const newText = interaction.options.getString("ответ");

    customResponses = loadJSON(RESPONSES_FILE, {});
    customResponses[cmdName] = newText;
    saveResponses();

    // Превью — показываем как будет выглядеть ответ в embed
    const previewText = newText
      .replace(/\[1\]/g, `**${interaction.user.username}**`)
      .replace(/\[2\]/g, "**Пользователь**")
      .replace(/\{percent\}/g, "42.69")
      .replace(/\{word\}/g, "слово");

    const previewEmbed = buildCustomEmbed(cmdName, previewText);

    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setTitle("⚙️ Ответ изменён")
        .setColor(0x5865f2)
        .addFields(
          { name: "Команда",    value: `\`!${cmdName}\``, inline: true },
          { name: "Шаблон",     value: `\`\`\`${newText}\`\`\`` },
          { name: "Переменные", value: "`[1]` — автор команды\n`[2]` — цель команды\n`{percent}` — процент (для !im)\n`{word}` — слово (для !im)" },
        ),
      new EmbedBuilder().setTitle("👁️ Превью").setColor(0x2b2d31).setDescription("Вот как будет выглядеть ответ:"),
      previewEmbed,
    ], ephemeral: true });
  }
});

// ─── PREFIX COMMANDS ───────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!")) return;

  const args     = message.content.slice(1).trim().split(/\s+/);
  const cmd      = args.shift().toLowerCase();
  const authorId = message.author.id;

  // Авто-ранг владельца сервера
  if (message.guild?.ownerId === authorId) {
    if (getRank(authorId) !== "S" && rankIndex(getRank(authorId)) < rankIndex("A")) setRank(authorId, "A");
  }

  // ── resolveTarget ─────────────────────────────────────────────────────────────
  async function resolveTarget(argIdx = 0) {
    if (message.reference) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        return ref.member || await message.guild.members.fetch(ref.author.id).catch(() => null);
      } catch { return null; }
    }
    const raw = args[argIdx];
    if (!raw) return null;
    return message.guild.members.fetch(raw.replace(/[<@!>]/g, "")).catch(() => null);
  }

  const beePack = () => { activePacks = loadJSON(ACTIVE_PACKS_FILE, []); return activePacks.includes("bee"); };
  const catPack = () => { activePacks = loadJSON(ACTIVE_PACKS_FILE, []); return activePacks.includes("cat"); };

  // ── Отправить ответ (кастомный или стандартный embed) ────────────────────────
  // sendReply используется для команд с одним действием и одним embed
  async function sendReply(cmdKey, defaultEmbed, author, target, extras = {}) {
    const tpl = getCustomResponse(cmdKey);
    if (tpl) {
      const text = applyTemplate(tpl, author, target?.user ?? target, extras);
      return message.channel.send({ embeds: [buildCustomEmbed(cmdKey, text)] });
    }
    return message.channel.send({ embeds: [defaultEmbed] });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // !getconfig — выгрузить снимок как .json файл
  // ═══════════════════════════════════════════════════════════════════════════════
  if (cmd === "getconfig") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const snap = buildSnapshot();
    const json = JSON.stringify(snap, null, 2);
    const buf  = Buffer.from(json, "utf8");
    const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const attachment = new AttachmentBuilder(buf, { name: `config_${date}.json` });
    return message.channel.send({
      embeds: [new EmbedBuilder()
        .setTitle("💾 Конфиг сохранён")
        .setColor(0x57f287)
        .setDescription("Прикреплён файл конфига. Сохрани его и загрузи позже через `!loadconfig`.")
        .addFields(
          { name: "Рангов",          value: `${Object.keys(snap.ranks).length}`,           inline: true },
          { name: "Активных паков",  value: snap.activePacks.join(", ") || "нет",           inline: true },
          { name: "Кастомных ответов", value: `${Object.keys(snap.customResponses).length}`, inline: true },
          { name: "Сохранено",       value: new Date(snap.savedAt).toLocaleString("ru-RU") },
        )],
      files: [attachment],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // !loadconfig — загрузить конфиг из прикреплённого .json файла
  // ═══════════════════════════════════════════════════════════════════════════════
  if (cmd === "loadconfig") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");

    const attachment = message.attachments.first();
    if (!attachment) return message.reply("❌ Прикрепи `.json` файл конфига к этому сообщению.");
    if (!attachment.name.endsWith(".json")) return message.reply("❌ Файл должен быть в формате `.json`.");

    let snap;
    try {
      const res = await fetch(attachment.url);
      const text = await res.text();
      snap = JSON.parse(text);
    } catch (e) {
      return message.reply(`❌ Не удалось прочитать файл: ${e.message}`);
    }

    // Базовая валидация
    if (typeof snap !== "object" || !snap.savedAt)
      return message.reply("❌ Файл не является валидным конфигом бота.");

    applySnapshot(snap);

    const date = new Date(snap.savedAt).toLocaleString("ru-RU");
    return message.channel.send({ embeds: [new EmbedBuilder()
      .setTitle("📂 Конфиг загружен")
      .setColor(0x57f287)
      .setDescription("✅ Все данные восстановлены из файла.")
      .addFields(
        { name: "Сохранён",        value: date,                                             inline: true },
        { name: "Активные паки",   value: (snap.activePacks ?? []).join(", ") || "нет",     inline: true },
        { name: "Рангов",          value: `${Object.keys(snap.ranks ?? {}).length}`,        inline: true },
        { name: "Кастомных ответов", value: `${Object.keys(snap.customResponses ?? {}).length}`, inline: true },
      )] });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // МОДЕРАЦИЯ (B+)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "mute") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
    let target, timeStr, reason;
    if (message.reference) { target = await resolveTarget(); timeStr = args[0]; reason = args.slice(1).join(" ") || "Не указана"; }
    else { target = await resolveTarget(0); timeStr = args[1]; reason = args.slice(2).join(" ") || "Не указана"; }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (target.user.id === authorId) return message.reply("❌ Нельзя замутить самого себя.");
    if (rankIndex(getRank(target.user.id)) >= rankIndex(getRank(authorId)))
      return message.reply("❌ Нельзя замутить пользователя с таким же или более высоким рангом.");
    const ms = parseTime(timeStr);
    if (!ms) return message.reply("❌ Укажи время: `1h30m`, `45m`, `90s`");
    try {
      await target.timeout(ms, reason);
      await sendReply("mute",
        new EmbedBuilder().setTitle("🔇 Мут выдан").setColor(0xfee75c)
          .addFields({ name: "Пользователь", value: target.user.tag, inline: true },
                     { name: "Время", value: formatTime(ms), inline: true },
                     { name: "Причина", value: reason }),
        message.author, target);
    } catch (e) { return message.reply(`❌ ${e.message}`); }
    return;
  }

  if (cmd === "unmute") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (rankIndex(getRank(target.user.id)) >= rankIndex(getRank(authorId)))
      return message.reply("❌ Нельзя снять мут у пользователя с таким же или более высоким рангом.");
    try {
      await target.timeout(null);
      await sendReply("unmute",
        new EmbedBuilder().setTitle("🔊 Мут снят").setColor(0x57f287)
          .addFields({ name: "Пользователь", value: target.user.tag }),
        message.author, target);
    } catch (e) { return message.reply(`❌ ${e.message}`); }
    return;
  }

  if (cmd === "ban") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
    let target, reason;
    if (message.reference) { target = await resolveTarget(); reason = args.join(" ") || "Не указана"; }
    else { target = await resolveTarget(0); reason = args.slice(1).join(" ") || "Не указана"; }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (target.user.id === authorId) return message.reply("❌ Нельзя забанить самого себя.");
    if (rankIndex(getRank(target.user.id)) >= rankIndex(getRank(authorId)))
      return message.reply("❌ Нельзя забанить пользователя с таким же или более высоким рангом.");
    try {
      await target.ban({ reason });
      await sendReply("ban",
        new EmbedBuilder().setTitle("🔨 Бан выдан").setColor(0xed4245)
          .addFields({ name: "Пользователь", value: target.user.tag, inline: true },
                     { name: "Причина", value: reason }),
        message.author, target);
    } catch (e) { return message.reply(`❌ ${e.message}`); }
    return;
  }

  if (cmd === "unban") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
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
      await sendReply("unban",
        new EmbedBuilder().setTitle("✅ Бан снят").setColor(0x57f287)
          .addFields({ name: "Пользователь", value: `<@${userId}> (${userId})` }),
        message.author, { id: userId, username: banned.user.tag });
    } catch (e) { return message.reply(`❌ ${e.message}`); }
    return;
  }

  if (cmd === "kick") {
    if (!hasRank(authorId, "B") && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **B** или выше.");
    let target, reason;
    if (message.reference) { target = await resolveTarget(); reason = args.join(" ") || "Не указана"; }
    else { target = await resolveTarget(0); reason = args.slice(1).join(" ") || "Не указана"; }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (target.user.id === authorId) return message.reply("❌ Нельзя кикнуть самого себя.");
    if (rankIndex(getRank(target.user.id)) >= rankIndex(getRank(authorId)))
      return message.reply("❌ Нельзя кикнуть пользователя с таким же или более высоким рангом.");
    try {
      await target.kick(reason);
      await sendReply("kick",
        new EmbedBuilder().setTitle("👢 Кик выдан").setColor(0xe67e22)
          .addFields({ name: "Пользователь", value: target.user.tag, inline: true },
                     { name: "Причина", value: reason }),
        message.author, target);
    } catch (e) { return message.reply(`❌ ${e.message}`); }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // РАНГИ (A+)
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "up") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");
    const tid = target.user.id;
    if (tid === authorId) return message.reply("❌ Нельзя повысить самого себя.");
    const cur = getRank(tid);
    if (cur === "cat") return message.reply("❌ Нельзя изменять ранг **cat** через `!up`. Используй `!set_rank`.");
    const nxt = rankUpOf(cur);
    if (!nxt) return message.reply(`❌ **${target.user.tag}** уже на максимальном ранге **${cur}**.`);
    if (!hasRank(authorId, "S") && rankIndex(nxt) > rankIndex("A"))
      return message.reply("❌ Ранг **A** может повышать максимум до **A**.");
    setRank(tid, nxt);
    return sendReply("up",
      new EmbedBuilder().setTitle("⬆️ Ранг повышен").setColor(0x57f287)
        .setDescription(`**${target.user.tag}**: **${cur}** → **${nxt}**`),
      message.author, target);
  }

  if (cmd === "down") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Пользователь не найден.");
    const tid = target.user.id;
    if (tid === authorId) return message.reply("❌ Нельзя понизить самого себя.");
    if (getRank(tid) === "S" && !hasRank(authorId, "S")) return message.reply("❌ Нельзя понижать **S** ранг.");
    if (getRank(tid) === "cat") return message.reply("❌ Нельзя изменять ранг **cat** через `!down`. Используй `!set_rank`.");
    const cur = getRank(tid);
    const prv = rankDownOf(cur);
    if (!prv) return message.reply(`❌ **${target.user.tag}** уже на минимальном ранге **${cur}**.`);
    setRank(tid, prv);
    return sendReply("down",
      new EmbedBuilder().setTitle("⬇️ Ранг понижен").setColor(0xed4245)
        .setDescription(`**${target.user.tag}**: **${cur}** → **${prv}**`),
      message.author, target);
  }

  if (cmd === "set_rank") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    let target, rankArg;
    if (message.reference) { target = await resolveTarget(); rankArg = args[0]?.toLowerCase(); }
    else { target = await resolveTarget(0); rankArg = args[1]?.toLowerCase(); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (target.user.id === authorId) return message.reply("❌ Нельзя изменить свой ранг.");
    const validRanks = [...RANK_ORDER.map(r => r.toLowerCase()), "cat"];
    if (!rankArg || !validRanks.includes(rankArg))
      return message.reply(`❌ Укажи ранг: ${RANK_ORDER.join(", ")}, cat`);
    const tid = target.user.id;
    const rankArgUp = rankArg === "cat" ? "cat" : rankArg.toUpperCase();
    if (rankArg === "cat" && !hasRank(authorId, "S")) return message.reply("❌ Только **S** может выдавать ранг **cat**.");
    if (rankArg !== "cat" && !hasRank(authorId, "S") && rankIndex(rankArgUp) > rankIndex("A"))
      return message.reply("❌ Ранг **A** может устанавливать максимум ранг **A**.");
    if (getRank(tid) === "S" && !hasRank(authorId, "S")) return message.reply("❌ Нельзя изменять ранг **S**.");
    const old = getRank(tid);
    setRank(tid, rankArgUp);
    return sendReply("set_rank",
      new EmbedBuilder().setTitle("🎖️ Ранг установлен").setColor(0x5865f2)
        .setDescription(`**${target.user.tag}**: **${old}** → **${rankArgUp}**`),
      message.author, target);
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
    if (grouped["cat"].length) lines.push(`**🐱 cat:** ${grouped["cat"].map(id => `<@${id}>`).join(", ")}`);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏅 Список рангов").setColor(0x5865f2)
      .setDescription(lines.join("\n") || "Никого нет")] });
  }

  if (cmd === "myrank") {
    const r = getRank(authorId);
    return message.reply(`🏅 Твой ранг: **${r === "cat" ? "🐱 cat" : r}**`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ПАКИ
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "dw_pack") {
    if (!hasRank(authorId, "A")) return message.reply("❌ Нужен ранг **A** или выше.");
    const packName = args[0]?.toLowerCase();
    if (!packName) return message.reply("❌ Укажи название пака: `!dw_pack <название>`");
    if (!PACK_REGISTRY[packName]) return message.reply(`❌ Пак **${packName}** не существует. Доступные: ${Object.keys(PACK_REGISTRY).join(", ")}`);
    activePacks = loadJSON(ACTIVE_PACKS_FILE, []);
    if (activePacks.includes(packName)) return message.reply(`⚠️ Пак **${packName}** уже подключён.`);
    activePacks.push(packName);
    saveActivePacks();
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("📦 Пак подключён").setColor(0x57f287)
      .setDescription(`Пак **${packName}** активирован! Используй \`/l_pack\` для просмотра команд.`)] });
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
    const ROLL_CD = 3600000;
    const now = Date.now();
    const elapsed = now - (u.lastRoll ? new Date(u.lastRoll).getTime() : 0);
    if (elapsed < ROLL_CD) {
      const rem = ROLL_CD - elapsed;
      return message.reply(`⏳ Следующий ролл через **${Math.floor(rem/60000)}м ${Math.floor((rem%60000)/1000)}с**`);
    }
    const bee = rollBee();
    if (!u.lastCollect) u.lastCollect = new Date(now).toISOString();
    u.lastRoll = new Date(now).toISOString();
    u.bees.push({ name: bee.name, emoji: bee.emoji });
    saveBeeData();
    const rarity = bee.chance >= 20 ? "Обычная" : bee.chance >= 5 ? "Редкая" : bee.chance >= 1 ? "Эпическая" : "Легендарная";
    const defaultEmbed = new EmbedBuilder()
      .setTitle(`${bee.emoji} Ты получил: ${bee.name}!`)
      .setColor(bee.chance >= 20 ? 0xfee75c : bee.chance >= 5 ? 0x57f287 : bee.chance >= 1 ? 0x9b59b6 : 0xe74c3c)
      .addFields(
        { name: "Редкость",   value: rarity,             inline: true },
        { name: "Шанс",       value: `${bee.chance}%`,   inline: true },
        { name: "Пыльца/час", value: `${bee.pollen} 🌸`, inline: true },
        { name: "Всего пчёл", value: `${u.bees.length}`, inline: true },
      );
    const tpl = getCustomResponse("roll_bee");
    if (tpl) {
      const text = applyTemplate(tpl, message.author, null, { bee: bee.name, emoji: bee.emoji, chance: bee.chance, pollen: bee.pollen, rarity });
      return message.channel.send({ embeds: [buildCustomEmbed("roll_bee", text)] });
    }
    return message.channel.send({ embeds: [defaultEmbed] });
  }

  if (cmd === "pollen") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const gained = collectPollen(authorId);
    const u = getBeeUser(authorId);
    const perHour = u.bees.reduce((s, b) => { const bee = BEES.find(x => x.name===b.name); return s+(bee?bee.pollen:0); }, 0);
    return sendReply("pollen",
      new EmbedBuilder().setTitle("🌸 Пыльца").setColor(0xf1c40f)
        .setDescription(`У **${message.author.username}**`)
        .addFields(
          { name: "Пыльца",     value: `${u.pollen} 🌸`,  inline: true },
          { name: "Пыльца/час", value: `${perHour} 🌸`,   inline: true },
          { name: "Пчёл",       value: `${u.bees.length}`, inline: true },
          ...(gained ? [{ name: "Собрано сейчас", value: `+${gained} 🌸` }] : []),
        ),
      message.author, null, { pollen: u.pollen, perhour: perHour });
  }

  if (cmd === "honey") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(authorId);
    return sendReply("honey",
      new EmbedBuilder().setTitle("🍯 Мёд").setColor(0xe67e22)
        .setDescription(`У **${message.author.username}**: **${u.honey}** 🍯`),
      message.author, null, { honey: u.honey });
  }

  if (cmd === "convert") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    collectPollen(authorId);
    const u = getBeeUser(authorId);
    const amount = args[0] ? parseInt(args[0]) : u.pollen;
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество пыльцы.");
    const usable = Math.floor(amount / 2) * 2;
    if (usable < 2) return message.reply("❌ Нужно минимум **2 пыльцы**.");
    if (u.pollen < usable) return message.reply(`❌ Недостаточно пыльцы. У тебя: **${u.pollen}** 🌸`);
    const honeyGained = usable / 2;
    u.pollen -= usable; u.honey += honeyGained;
    saveBeeData();
    return sendReply("convert",
      new EmbedBuilder().setTitle("🍯 Конвертация").setColor(0xe67e22)
        .addFields(
          { name: "Потрачено пыльцы", value: `${usable} 🌸`,     inline: true },
          { name: "Получено мёда",    value: `${honeyGained} 🍯`, inline: true },
          { name: "Остаток пыльцы",   value: `${u.pollen} 🌸`,   inline: true },
          { name: "Всего мёда",       value: `${u.honey} 🍯`,     inline: true },
        ),
      message.author, null, { spent: usable, gained: honeyGained, pollen: u.pollen, honey: u.honey });
  }

  if (cmd === "top_bee") {
    if (!beePack()) return;
    beeData = loadJSON(BEE_FILE, {});
    const sorted = Object.entries(beeData).map(([uid, d]) => ({ uid, honey: d.honey||0 })).sort((a,b)=>b.honey-a.honey).slice(0,10);
    if (!sorted.length) return message.reply("📊 Пока никто не собрал мёд.");
    const medals = ["🥇","🥈","🥉"];
    const lines = sorted.map((e,i) => `${medals[i]||`${i+1}.`} <@${e.uid}> — **${e.honey}** 🍯`);
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🏆 Топ мёда").setColor(0xf1c40f).setDescription(lines.join("\n"))] });
  }

  if (cmd === "get_bee") {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    const bee = getBeeByName(args.join(" "));
    if (!bee) return message.reply(`❌ Пчела не найдена. Доступны: ${BEES.map(b=>b.name).join(", ")}`);
    beeData = loadJSON(BEE_FILE, {}); getBeeUser(authorId).bees.push({ name: bee.name, emoji: bee.emoji }); saveBeeData();
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
    beeData = loadJSON(BEE_FILE, {}); getBeeUser(target.user.id).bees.push({ name: bee.name, emoji: bee.emoji }); saveBeeData();
    return message.reply(`✅ **${target.user.tag}** получил **${bee.emoji} ${bee.name}**!`);
  }

  async function beeAdminStat(isGet, resource) {
    if (!beePack()) return;
    if (!hasRank(authorId, "S")) return message.reply("❌ Нужен ранг **S**.");
    let target, amount;
    if (message.reference) { target = await resolveTarget(); amount = parseInt(args[0]); }
    else { target = await resolveTarget(0); amount = parseInt(args[1]); }
    if (!target) return message.reply("❌ Пользователь не найден.");
    if (isNaN(amount) || amount <= 0) return message.reply("❌ Укажи количество.");
    beeData = loadJSON(BEE_FILE, {});
    const u = getBeeUser(target.user.id);
    const emoji = resource === "honey" ? "🍯" : "🌸";
    if (isGet) { u[resource] += amount; }
    else        { u[resource] = Math.max(0, u[resource] - amount); }
    saveBeeData();
    return message.reply(`✅ **${target.user.tag}** ${isGet?"+":"-"}${amount} ${emoji} (теперь: ${u[resource]})`);
  }

  if (cmd === "get_honey")    return beeAdminStat(true,  "honey");
  if (cmd === "give_honey")   return beeAdminStat(false, "honey");
  if (cmd === "get_pollen")   return beeAdminStat(true,  "pollen");
  if (cmd === "give_pollen")  return beeAdminStat(false, "pollen");

  // ═══════════════════════════════════════════════════════════════════════════════
  // ПАК: CAT
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "cat_raid") {
    if (!catPack()) return;
    if (!hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const count = Math.floor(Math.random()*8)+3;
    await message.channel.send(`🐱 **КОТ-РЕЙД!** Летит **${count}** котов!`);
    const urls = await fetchCatImages(count);
    for (const url of urls) await message.channel.send({ embeds: [new EmbedBuilder().setImage(url).setColor(0xff69b4)] });
    return;
  }

  async function catAction(cmdKey, defaultTitle, defaultDesc, defaultColor, catOnly = true) {
    if (!catPack()) return;
    if (catOnly && !hasCatRank(authorId)) return message.reply("❌ Нужен ранг **cat**.");
    const target = await resolveTarget(0);
    if (!target) return message.reply("❌ Укажи пользователя или ответь на сообщение.");
    if (!catOnly && !hasCatRank(target.user.id))
      return message.reply(`❌ **${target.user.username}** не кот. Эту команду можно применять только к котам!`);
    if (cmdKey === "piss" && hasRank(target.user.id, "S"))
      return message.reply("❌ Нельзя пописать на **S** ранг! Они слишком могущественны. 😤");
    return sendReply(cmdKey,
      new EmbedBuilder().setTitle(defaultTitle).setColor(defaultColor)
        .setDescription(defaultDesc.replace("{user}", message.author.username).replace("{target}", target.user.username)),
      message.author, target);
  }

  if (cmd === "bite")  return catAction("bite",  "😼 Укус!",             "**{user}** укусил **{target}**! 🦷",       0xff4444);
  if (cmd === "claw")  return catAction("claw",  "🐾 Царапина!",         "**{user}** поцарапал **{target}**! 🩸",    0xff8800);
  if (cmd === "lick")  return catAction("lick",  "👅 Облизывание!",      "**{user}** облизал **{target}**! 😹",      0xffccdd);
  if (cmd === "piss")  return catAction("piss",  "💦 Территория помечена!", "**{user}** пописал на **{target}**! 💛", 0xffff00);
  if (cmd === "pet")   return catAction("pet",   "🐱 Гладим кота!",      "**{user}** гладит **{target}**! 😻",       0xffccff, false);
  if (cmd === "smack") return catAction("smack", "😘 Чмок!",             "**{user}** чмокнул **{target}**! 💋",      0xff99cc, false);

  // ═══════════════════════════════════════════════════════════════════════════════
  // !im
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "im") {
    const word = args.join(" ");
    if (!word) return message.reply("❌ Напиши слово: `!im <слово>`");
    const percent = (Math.random()*99.99+0.01).toFixed(2);
    const tpl = getCustomResponse("im");
    if (tpl) {
      const text = applyTemplate(tpl, message.author, null, { percent, word });
      return message.reply({ embeds: [buildCustomEmbed("im", text)] });
    }
    return message.reply(`**${message.author.username}** на **${percent}%** ${word}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HELP
  // ═══════════════════════════════════════════════════════════════════════════════

  if (cmd === "help") {
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("📋 Команды бота").setColor(0x5865f2)
      .addFields(
        { name: "👮 Модерация (B+)", value: ["`!mute [user] [время] [причина]`","`!unmute [user]`","`!ban [user] [причина]`","`!unban [user/ID]`","`!kick [user] [причина]`"].join("\n") },
        { name: "🏅 Ранги (A+)",    value: ["`!up [user]`","`!down [user]`","`!set_rank [user] <ранг>`","`!lrangs`","`!myrank`"].join("\n") },
        { name: "📦 Паки (A+)",     value: ["`!dw_pack <название>` — подключить","`!rm_pack <название>` — отключить [S]","`/l_pack` — список паков"].join("\n") },
        { name: "💾 Конфиги (A+)",  value: ["`!getconfig` — сохранить конфиг как файл","`!loadconfig` + прикреплённый `.json` — загрузить конфиг"].join("\n") },
        { name: "⚙️ Кастомизация",  value: ["`/config <команда> <ответ>` — изменить ответ бота [A+]","`[1]` = автор, `[2]` = цель"].join("\n") },
        { name: "🎲 Разное",        value: ["`!im <слово>`"].join("\n") },
        { name: "📖 Справка паков", value: ["`!help_bee`","`!help_cat`"].join("\n") },
      ).setFooter({ text: "[user] можно заменить ответом на сообщение" })] });
  }

  if (cmd === "help_bee") {
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🐝 Пак Bee").setColor(0xf1c40f)
      .addFields(
        { name: "Для всех", value: ["`!roll_bee` — пчела (раз в час)","`!pollen`","`!honey`","`!convert [кол-во]`","`!top_bee`"].join("\n") },
        { name: "S-ранг",   value: ["`!get_bee <пчела>`","`!give_bee [user] <пчела>`","`!get/give_honey [user] <n>`","`!get/give_pollen [user] <n>`"].join("\n") },
        { name: "Пчёлы",    value: BEES.map(b=>`${b.emoji} **${b.name}** — ${b.chance}% | ${b.pollen} 🌸/ч`).join("\n") },
      ).setFooter({ text: "Подключить: !dw_pack bee" })] });
  }

  if (cmd === "help_cat") {
    return message.channel.send({ embeds: [new EmbedBuilder().setTitle("🐱 Пак Cat").setColor(0xff69b4)
      .addFields(
        { name: "Для всех",  value: ["`!pet [кот]` — погладить","`!smack [кот]` — чмокнуть"].join("\n") },
        { name: "Ранг cat",  value: ["`!cat_raid`","`!bite [user]`","`!claw [user]`","`!lick [user]`","`!piss [user]` (не S)"].join("\n") },
        { name: "О ранге cat", value: "Выдаётся **S** рангом через `!set_rank [user] cat`.\nКоты имеют доступ ко всем командам B+." },
      ).setFooter({ text: "Подключить: !dw_pack cat" })] });
  }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
client.login(TOKEN);
