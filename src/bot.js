require("dotenv").config();
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const {
  getDriveClientServiceAccount,
  isFolderMime,
  listFolderChildren,
  getFileMeta,
  downloadOrExportFile,
  downloadOrExportFileBuffer,
  crawlFolderTree,
} = require("./drive");
const { askAcademicAssistant, askStudyAssistant, isAiEnabled } = require("./ai");
const { getChatState, resetChatState } = require("./state");
const {
  loadUsers,
  saveUsers,
  touchUser,
  incrementDownload,
  markWelcomeSent,
  hasSeenWelcome,
  getStats,
} = require("./users");

const log = pino({ level: "info" });

const ROOT_FOLDER_IDS = (process.env.ROOT_FOLDER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 90);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 40);
const INDEX_REFRESH_MINUTES = Number(process.env.INDEX_REFRESH_MINUTES || 10);
const BROADCAST_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 1500);
const AI_CANDIDATE_LIMIT = Number(process.env.AI_CANDIDATE_LIMIT || 12);
const AI_STUDY_FILE_LIMIT = Number(process.env.AI_STUDY_FILE_LIMIT || 2);
const AI_SOURCE_FILE_MAX_MB = Number(process.env.AI_SOURCE_FILE_MAX_MB || 18);

const OWNER_NUMBER = (process.env.OWNER_NUMBER || "").replace(/\D/g, "");
const OWNER_CHAT_ID = (process.env.OWNER_CHAT_ID || "").trim();
const BOT_NAME = process.env.BOT_NAME || "UNN/UNEC Academic Materials Assistant";

const INDEX_FILE = path.join(__dirname, "..", "data", "search-index.json");

if (!ROOT_FOLDER_IDS.length) {
  throw new Error("ROOT_FOLDER_IDS is not set in .env");
}

const drive = getDriveClientServiceAccount();

let SEARCH_INDEX = [];
let INDEX_READY = false;
let INDEX_BUILDING = false;
let BROADCAST_RUNNING = false;

let USERS = loadUsers();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeChatNumber(chatId) {
  return String(chatId || "").replace(/\D/g, "");
}

function isOwner(msg) {
  const rawFrom = String(msg.from || "");
  const normalizedIncoming = normalizeChatNumber(rawFrom);

  if (OWNER_CHAT_ID && rawFrom === OWNER_CHAT_ID) return true;
  if (OWNER_NUMBER && normalizedIncoming === OWNER_NUMBER) return true;

  return false;
}

function isDirectUserChat(chatId) {
  if (!chatId) return false;
  if (chatId === "status@broadcast") return false;
  if (String(chatId).endsWith("@g.us")) return false;
  return true;
}

function getBroadcastTargets(users) {
  return Object.keys(users || {}).filter(isDirectUserChat);
}

function getWelcomeMessage() {
  return (
    `Welcome to *${BOT_NAME}*.\n\n` +
    `This assistant helps students find lecture notes, past questions, and study materials from the curated UNN/UNEC library using natural language.\n\n` +
    `You can ask things like:\n` +
    `- I need 2nd MBBS biochemistry past questions\n` +
    `- Send anatomy lecture notes for first semester\n` +
    `- What should I read for physiology revision?\n` +
    `- Explain glycolysis from the biochemistry material\n` +
    `- Ask me possible exam questions on anatomy\n\n` +
    `Type *home* to browse folders, *search <name>* for direct search, or simply describe the material you need.`
  );
}

function scoreMatch(query, item) {
  const q = normalize(query);
  const n = normalize(item.name);
  const p = normalize(item.path || "");

  if (!q) return 0;
  if (n === q) return 200;
  if (n.includes(q)) return 120;
  if (p.includes(q)) return 80;

  const qTokens = q.split(" ").filter(Boolean);
  const nTokens = n.split(" ").filter(Boolean);
  const pTokens = p.split(" ").filter(Boolean);

  let score = 0;

  for (const qt of qTokens) {
    if (nTokens.includes(qt)) score += 20;
    else if (pTokens.includes(qt)) score += 10;

    for (const nt of nTokens) {
      if (qt.length >= 3 && nt.startsWith(qt)) score += 6;
      if (qt.length >= 3 && nt.includes(qt)) score += 4;
    }

    for (const pt of pTokens) {
      if (qt.length >= 3 && pt.startsWith(qt)) score += 3;
    }
  }

  if (!isFolderMime(item.mimeType)) score += 5;
  return score;
}

function ensureIndexDir() {
  const dir = path.dirname(INDEX_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadIndexFromDisk() {
  try {
    if (!fs.existsSync(INDEX_FILE)) {
      log.info("No saved search index found on disk");
      return;
    }

    const raw = fs.readFileSync(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      SEARCH_INDEX = parsed;
      INDEX_READY = parsed.length > 0;
      log.info({ count: parsed.length }, "Loaded search index from disk");
    }
  } catch (err) {
    log.error(err, "Failed to load search index from disk");
  }
}

function saveIndexToDisk() {
  try {
    ensureIndexDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(SEARCH_INDEX, null, 2), "utf8");
    log.info({ count: SEARCH_INDEX.length }, "Search index saved to disk");
  } catch (err) {
    log.error(err, "Failed to save search index to disk");
  }
}

async function buildSearchIndex() {
  if (INDEX_BUILDING) return;
  INDEX_BUILDING = true;

  try {
    log.info("Building search index from Google Drive...");
    const indexed = [];

    for (const rootId of ROOT_FOLDER_IDS) {
      const rootMeta = await getFileMeta(drive, rootId);

      indexed.push({
        id: rootMeta.id,
        name: rootMeta.name,
        mimeType: rootMeta.mimeType,
        size: rootMeta.size || null,
        modifiedTime: rootMeta.modifiedTime || null,
        path: rootMeta.name,
        rootFolderId: rootMeta.id,
      });

      const items = await crawlFolderTree(drive, rootId, rootMeta.name);
      indexed.push(...items);
    }

    SEARCH_INDEX = indexed;
    INDEX_READY = indexed.length > 0;

    saveIndexToDisk();
    log.info({ count: SEARCH_INDEX.length }, "Search index built");
  } catch (err) {
    log.error(err, "Failed to build search index");
  } finally {
    INDEX_BUILDING = false;
  }
}

function searchIndex(query, limit = 10) {
  return SEARCH_INDEX
    .map((item) => ({
      ...item,
      _score: scoreMatch(query, item),
    }))
    .filter((item) => item._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function formatBreadcrumb(breadcrumb) {
  if (!breadcrumb.length) return "Home";
  return breadcrumb.map((b) => b.name).join(" / ");
}

function formatList(items, breadcrumb, mode = "browse") {
  let text = "";

  if (mode === "browse") {
    text += `*${formatBreadcrumb(breadcrumb)}*\n\n`;
  } else {
    text += `*Search results*\n\n`;
  }

  items.forEach((it, idx) => {
    const icon = isFolderMime(it.mimeType) ? "[Folder]" : "[File]";
    text += `${idx + 1}) ${icon} ${it.name}`;
    if (mode === "search" && it.path) {
      text += `\n   ${it.path}`;
    }
    text += `\n`;
  });

  text += `\nReply with a number.\nCommands: *home*, *back*, *browse*, *search <name>*`;
  return text;
}

function formatAiMatchList(items) {
  let text = "Best matches from the current UNN/UNEC library:\n\n";

  items.forEach((it, idx) => {
    const label = isFolderMime(it.mimeType) ? "Folder" : "File";
    text += `${idx + 1}) [${label}] ${it.name}`;
    if (it.path) text += `\n   ${it.path}`;
    text += "\n";
  });

  text += `\nReply with a number, or say "send 1" / "open 1".`;
  return text;
}

function parseNaturalSelection(text) {
  const normalized = String(text || "").toLowerCase().trim();
  const match = normalized.match(
    /^(?:send|open|get|give me)?\s*(?:the\s*)?(1|1st|one|first|2|2nd|two|second|3|3rd|three|third|4|4th|four|fourth|5|5th|five|fifth)(?:\s+(?:one|item|option|result))?\s*$/i
  );

  if (!match) return null;

  const raw = match[1];
  const map = {
    "1": 0,
    "1st": 0,
    one: 0,
    first: 0,
    "2": 1,
    "2nd": 1,
    two: 1,
    second: 1,
    "3": 2,
    "3rd": 2,
    three: 2,
    third: 2,
    "4": 3,
    "4th": 3,
    four: 3,
    fourth: 3,
    "5": 4,
    "5th": 4,
    five: 4,
    fifth: 4,
  };

  return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : null;
}

function isAffirmative(text) {
  return /^(yes|yeah|yep|ok|okay|sure|please do|go ahead|send it|open it|get it)$/i.test(
    String(text || "").trim()
  );
}

function isSendIntent(text) {
  return /\b(send|give me|get me|download)\b/i.test(String(text || ""));
}

function isStudyIntent(text) {
  return /\b(explain|what is|define|discuss|outline|summari[sz]e|teach|revise|revision|quiz|test me|exam question|possible exam|mcq|short note|differentiate|compare|highlight|mention|list|state|describe|how does|why does)\b|\?/i.test(
    String(text || "")
  );
}

function pickStudyItems(st, query) {
  const currentStudyItems = Array.isArray(st.studyItems) ? st.studyItems : [];
  if (currentStudyItems.length) {
    return currentStudyItems.filter((item) => !isFolderMime(item.mimeType)).slice(0, AI_STUDY_FILE_LIMIT);
  }

  return searchIndex(query, AI_CANDIDATE_LIMIT)
    .filter((item) => !isFolderMime(item.mimeType))
    .slice(0, AI_STUDY_FILE_LIMIT);
}

async function buildStudyMaterials(items) {
  const materials = [];

  for (const item of items) {
    try {
      const meta = await getFileMeta(drive, item.id);
      const sizeMb = meta.size ? Number(meta.size) / (1024 * 1024) : 0;

      if (sizeMb > AI_SOURCE_FILE_MAX_MB) {
        continue;
      }

      const downloaded = await downloadOrExportFileBuffer(drive, meta);
      const buffer = downloaded.buffer;
      const mimeType = downloaded.mimeType;

      if (!buffer || !buffer.length) continue;

      if (
        mimeType === "application/pdf" ||
        mimeType === "text/plain" ||
        mimeType === "text/markdown" ||
        mimeType === "application/json" ||
        mimeType === "text/csv"
      ) {
        materials.push({
          type: mimeType.startsWith("text/") || mimeType === "application/json" ? "text" : "inline_data",
          name: meta.name,
          path: item.path || meta.name,
          mimeType,
          data: mimeType === "application/pdf" ? buffer.toString("base64") : undefined,
          text:
            mimeType === "application/pdf"
              ? undefined
              : buffer.toString("utf8").slice(0, 120000),
        });
      } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        materials.push({
          type: "inline_data",
          name: meta.name,
          path: item.path || meta.name,
          mimeType,
          data: buffer.toString("base64"),
        });
      }
    } catch (err) {
      log.error({ err: err.message, itemId: item.id }, "Failed to prepare study material");
    }
  }

  return materials;
}

async function loadRoots(st) {
  if (st.roots.length) return;

  const roots = [];
  for (const id of ROOT_FOLDER_IDS) {
    const meta = await getFileMeta(drive, id);
    roots.push({
      id,
      name: meta.name || id,
      mimeType: meta.mimeType,
    });
  }

  st.roots = roots;
}

async function showHome(msg) {
  const st = getChatState(msg.from);
  await loadRoots(st);

  st.folderId = null;
  st.breadcrumb = [];
  st.lastMode = "browse";
  st.pendingItem = null;
  st.studyItems = [];
  st.lastItems = st.roots.map((r) => ({
    id: r.id,
    name: r.name,
    mimeType: r.mimeType,
  }));

  await msg.reply(
    "*Home Folders*\n\n" +
      st.lastItems.map((it, idx) => `${idx + 1}) [Folder] ${it.name}`).join("\n") +
      "\n\nReply with a number to open, or describe the material you need."
  );
}

async function showFolder(msg, folderId, pushBreadcrumb = null) {
  const st = getChatState(msg.from);
  const children = await listFolderChildren(drive, folderId, PAGE_SIZE);

  st.folderId = folderId;
  st.lastMode = "browse";
  st.pendingItem = null;
  st.studyItems = [];
  if (pushBreadcrumb) st.breadcrumb.push(pushBreadcrumb);

  st.lastItems = children.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
  }));

  if (!st.lastItems.length) {
    await msg.reply("This folder is empty.\nType *back* or *home*.");
    return;
  }

  await msg.reply(formatList(st.lastItems, st.breadcrumb, "browse"));
}

async function doSearch(msg, query) {
  if (!INDEX_READY) {
    await msg.reply("Search index is still loading. Try again in a few seconds.");
    return;
  }

  const st = getChatState(msg.from);
  const results = searchIndex(query, 10);

  if (!results.length) {
    await msg.reply("No matches found. Try a different keyword.");
    return;
  }

  st.lastItems = results.map((r) => ({
    id: r.id,
    name: r.name,
    mimeType: r.mimeType,
    path: r.path,
  }));
  st.lastMode = "search";
  st.pendingItem = null;
  st.studyItems = results.filter((item) => !isFolderMime(item.mimeType)).slice(0, AI_STUDY_FILE_LIMIT);

  await msg.reply(formatList(results, st.breadcrumb, "search"));
}

async function sendFileAsDocument(msg, fileId) {
  const meta = await getFileMeta(drive, fileId);

  if (meta.size) {
    const sizeMb = Number(meta.size) / (1024 * 1024);
    if (sizeMb > MAX_FILE_MB) {
      await msg.reply(`File is too large (${sizeMb.toFixed(1)} MB). Try a smaller file.`);
      return;
    }
  }

  await msg.reply(`Preparing: *${meta.name}*`);
  const filePath = await downloadOrExportFile(drive, meta);

  const media = MessageMedia.fromFilePath(filePath);
  await client.sendMessage(msg.from, media, { sendMediaAsDocument: true });

  try {
    fs.unlinkSync(filePath);
  } catch (_) {}

  incrementDownload(USERS, msg);
  saveUsers(USERS);

  await msg.reply("Sent successfully. Study well.");
}

function getOwnerStatsMessage() {
  const stats = getStats(USERS);

  return (
    `*Bot Analytics*\n\n` +
    `Total users: ${stats.totalUsers}\n` +
    `Daily active users: ${stats.dailyUsers}\n` +
    `Weekly active users: ${stats.weeklyUsers}\n` +
    `Monthly active users: ${stats.monthlyUsers}\n\n` +
    `Total messages: ${stats.totalMessages}\n` +
    `Total downloads: ${stats.totalDownloads}`
  );
}

async function runBroadcast(ownerMsg, body) {
  if (BROADCAST_RUNNING) {
    await ownerMsg.reply("A broadcast is already running.");
    return;
  }

  const message = body.trim();
  if (!message) {
    await ownerMsg.reply("Usage:\n*broadcast Your message here*");
    return;
  }

  BROADCAST_RUNNING = true;

  const targets = getBroadcastTargets(USERS).filter((chatId) => chatId !== ownerMsg.from);
  let sent = 0;
  let failed = 0;

  await ownerMsg.reply(
    `Broadcast started.\n\nTarget users: ${targets.length}\nDelay: ${BROADCAST_DELAY_MS}ms`
  );

  for (const chatId of targets) {
    try {
      await client.sendMessage(chatId, message);
      sent += 1;
    } catch (err) {
      failed += 1;
      log.error({ chatId, err: err.message }, "Broadcast send failed");
    }

    await sleep(BROADCAST_DELAY_MS);
  }

  BROADCAST_RUNNING = false;

  await ownerMsg.reply(
    `Broadcast completed.\n\nTargeted: ${targets.length}\nSent: ${sent}\nFailed: ${failed}`
  );
}

async function handlePendingChoice(msg, text, st) {
  if (!st.pendingItem) return false;

  if (!isAffirmative(text) && !isSendIntent(text)) {
    return false;
  }

  const pending = st.pendingItem;
  st.pendingItem = null;

  if (isFolderMime(pending.mimeType)) {
    st.breadcrumb = [{ id: pending.id, name: pending.name }];
    st.studyItems = [];
    await msg.reply(`Opening *${pending.name}* for you.`);
    await showFolder(msg, pending.id, null);
    return true;
  }

  st.studyItems = [pending];
  await msg.reply(`Sending *${pending.name}*. Make good use of it.`);
  await sendFileAsDocument(msg, pending.id);
  return true;
}

async function handleAiQuery(msg, query) {
  if (!INDEX_READY) {
    await msg.reply("Search index is still loading. Try again in a few seconds.");
    return;
  }

  const st = getChatState(msg.from);
  const candidates = searchIndex(query, AI_CANDIDATE_LIMIT);

  if (!candidates.length) {
    st.pendingItem = null;
    st.studyItems = [];
    await msg.reply(
      "I could not find a relevant material in the current UNN/UNEC library. Please mention the course, level, semester, or material type."
    );
    return;
  }

  if (!isAiEnabled()) {
    await doSearch(msg, query);
    return;
  }

  let aiResult;

  try {
    aiResult = await askAcademicAssistant({
      query,
      candidates,
      botName: BOT_NAME,
    });
  } catch (err) {
    log.error(err, "AI retrieval failed");
    await doSearch(msg, query);
    return;
  }

  const candidateMap = new Map(candidates.map((item) => [item.id, item]));
  let selectedItems = aiResult.selectedIds
    .map((id) => candidateMap.get(id))
    .filter(Boolean);

  if (!selectedItems.length) {
    selectedItems = candidates.slice(0, Math.min(5, candidates.length));
  }

  const responseText =
    aiResult.reply ||
    "I found relevant materials in the current UNN/UNEC library. See the best matches below.";

  if (aiResult.action === "clarify") {
    st.pendingItem = null;
    st.studyItems = [];
    await msg.reply(responseText);
    return;
  }

  if (aiResult.action === "open_folder") {
    const folder = selectedItems.find((item) => isFolderMime(item.mimeType));

    if (!folder) {
      await msg.reply(`${responseText}\n\n${formatAiMatchList(selectedItems)}`);
      st.lastItems = selectedItems;
      st.lastMode = "search";
      st.pendingItem = selectedItems[0] || null;
      st.studyItems = selectedItems.filter((item) => !isFolderMime(item.mimeType)).slice(0, AI_STUDY_FILE_LIMIT);
      return;
    }

    st.breadcrumb = [{ id: folder.id, name: folder.name }];
    st.pendingItem = null;
    st.studyItems = [];
    await msg.reply(responseText);
    await showFolder(msg, folder.id, null);
    return;
  }

  if (aiResult.action === "send_file") {
    const file = selectedItems.find((item) => !isFolderMime(item.mimeType));

    if (!file) {
      await msg.reply(`${responseText}\n\n${formatAiMatchList(selectedItems)}`);
      st.lastItems = selectedItems;
      st.lastMode = "search";
      st.pendingItem = selectedItems[0] || null;
      st.studyItems = selectedItems.filter((item) => !isFolderMime(item.mimeType)).slice(0, AI_STUDY_FILE_LIMIT);
      return;
    }

    st.pendingItem = null;
    st.studyItems = [file];
    await msg.reply(responseText);
    await sendFileAsDocument(msg, file.id);
    return;
  }

  st.lastItems = selectedItems;
  st.lastMode = "search";
  st.pendingItem = selectedItems.length === 1 ? selectedItems[0] : null;
  st.studyItems = selectedItems.filter((item) => !isFolderMime(item.mimeType)).slice(0, AI_STUDY_FILE_LIMIT);

  let message = responseText;
  if (selectedItems.length) {
    message += `\n\n${formatAiMatchList(selectedItems)}`;
  }
  if (st.pendingItem && !isFolderMime(st.pendingItem.mimeType)) {
    message += `\n\nIf you want the top file immediately, reply "send it".`;
  }

  await msg.reply(message);
}

async function handleStudyQuestion(msg, query) {
  const st = getChatState(msg.from);
  const studyItems = pickStudyItems(st, query);

  if (!studyItems.length) {
    await handleAiQuery(msg, query);
    return true;
  }

  if (!isAiEnabled()) {
    await doSearch(msg, query);
    return true;
  }

  const materials = await buildStudyMaterials(studyItems);

  if (!materials.length) {
    await msg.reply(
      "I found likely materials, but I could not read enough source content from them yet. Try asking for the material first, then ask your question again."
    );
    return true;
  }

  try {
    const answer = await askStudyAssistant({
      query,
      materials,
      botName: BOT_NAME,
    });

    st.studyItems = studyItems;
    await msg.reply(answer || "I reviewed the provided material set, but I could not produce a useful answer.");
  } catch (err) {
    log.error(err, "Study assistant failed");
    await msg.reply(
      "I could not complete the material-based explanation right now. Please try again shortly."
    );
  }

  return true;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "drive-doc-bot",
    dataPath: path.join(__dirname, "..", ".wwebjs_auth"),
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));

client.on("ready", async () => {
  log.info("WhatsApp bot ready");

  loadIndexFromDisk();

  buildSearchIndex().catch((err) => {
    log.error(err, "Initial search index build failed");
  });

  setInterval(() => {
    buildSearchIndex().catch((err) => {
      log.error(err, "Scheduled search index rebuild failed");
    });
  }, INDEX_REFRESH_MINUTES * 60 * 1000);
});

client.on("message", async (msg) => {
  try {
    const text = (msg.body || "").trim();
    if (!text) return;
    if (msg.from === "status@broadcast") return;

    touchUser(USERS, msg);
    saveUsers(USERS);

    if (!hasSeenWelcome(USERS, msg)) {
      await msg.reply(getWelcomeMessage());
      markWelcomeSent(USERS, msg);
      saveUsers(USERS);
    }

    const st = getChatState(msg.from);
    const low = text.toLowerCase();

    if (await handlePendingChoice(msg, text, st)) {
      return;
    }

    if (low === "help") {
      await msg.reply(
        `*${BOT_NAME}*\n\n` +
          "- Describe the material you need in natural language\n" +
          "- *home* - show main folders\n" +
          "- *browse* - browse current folder\n" +
          "- *back* - go back\n" +
          "- *search <name>* - direct keyword search\n" +
          "- Ask course questions from the material or request possible exam questions\n" +
          "- Reply with a number to open or download a result\n\n" +
          "Owner commands:\n" +
          "- *stats*\n" +
          "- *broadcast Your message here*"
      );
      return;
    }

    if (low === "community") {
      await msg.reply(
        "This assistant is currently focused on academic materials. Describe the lecture note, past question, or course material you need."
      );
      return;
    }

    if (low === "stats" || low === "analytics" || low === "/stats") {
      if (!isOwner(msg)) {
        await msg.reply("You are not authorized to use this command.");
        return;
      }
      await msg.reply(getOwnerStatsMessage());
      return;
    }

    if (low.startsWith("broadcast ")) {
      if (!isOwner(msg)) {
        await msg.reply("You are not authorized to use this command.");
        return;
      }
      const body = text.slice("broadcast ".length);
      await runBroadcast(msg, body);
      return;
    }

    if (low === "broadcast") {
      if (!isOwner(msg)) {
        await msg.reply("You are not authorized to use this command.");
        return;
      }
      await msg.reply("Usage:\n*broadcast Your message here*");
      return;
    }

    if (low === "home" || low === "start" || low === "menu") {
      resetChatState(msg.from);
      await showHome(msg);
      return;
    }

    if (low === "browse") {
      if (!st.folderId) {
        await showHome(msg);
        return;
      }
      await showFolder(msg, st.folderId, null);
      return;
    }

    if (low === "back") {
      st.pendingItem = null;
      st.studyItems = [];

      if (!st.breadcrumb.length) {
        await showHome(msg);
        return;
      }

      st.breadcrumb.pop();
      const parent = st.breadcrumb.length
        ? st.breadcrumb[st.breadcrumb.length - 1].id
        : null;

      if (!parent) {
        await showHome(msg);
        return;
      }

      st.folderId = parent;
      await showFolder(msg, parent, null);
      return;
    }

    if (low.startsWith("search ")) {
      const q = text.slice(7).trim();
      if (!q) {
        await msg.reply("Type: *search <file name>*");
        return;
      }
      await doSearch(msg, q);
      return;
    }

    if (/^\d+$/.test(text)) {
      const idx = parseInt(text, 10) - 1;
      const chosen = st.lastItems[idx];

      if (!chosen) {
        await msg.reply("Invalid selection. Reply with a valid number.");
        return;
      }

      st.pendingItem = null;
      st.studyItems = [];

      if (isFolderMime(chosen.mimeType)) {
        if (!st.breadcrumb.length || st.lastMode === "search") {
          st.breadcrumb = [{ id: chosen.id, name: chosen.name }];
        } else {
          st.breadcrumb.push({ id: chosen.id, name: chosen.name });
        }

        await showFolder(msg, chosen.id, null);
        return;
      }

      st.studyItems = [chosen];
      await sendFileAsDocument(msg, chosen.id);
      return;
    }

    const naturalSelection = parseNaturalSelection(text);
    if (naturalSelection !== null) {
      const chosen = st.lastItems[naturalSelection];

      if (!chosen) {
        await msg.reply("I do not have that option in the current list.");
        return;
      }

      st.pendingItem = null;
      st.studyItems = [];

      if (isFolderMime(chosen.mimeType)) {
        st.breadcrumb = [{ id: chosen.id, name: chosen.name }];
        await showFolder(msg, chosen.id, null);
        return;
      }

      st.studyItems = [chosen];
      await sendFileAsDocument(msg, chosen.id);
      return;
    }

    if (isStudyIntent(text)) {
      await handleStudyQuestion(msg, text);
      return;
    }

    if (text.length >= 2) {
      await handleAiQuery(msg, text);
      return;
    }

    await msg.reply("Type *home*, *browse*, *search <name>*, or describe the material you need.");
  } catch (err) {
    log.error(err);
    try {
      await msg.reply("Error. Try again.");
    } catch (_) {}
    BROADCAST_RUNNING = false;
  }
});

client.initialize();
