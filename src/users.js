const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadUsers() {
  try {
    ensureDataDir();

    if (!fs.existsSync(USERS_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }

    return {};
  } catch (err) {
    console.error("Failed to load users.json:", err.message);
    return {};
  }
}

function saveUsers(users) {
  try {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save users.json:", err.message);
  }
}

function getUserId(msg) {
  return msg.from;
}

function getUserRecord(users, userId) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      firstSeen: null,
      lastSeen: null,
      messageCount: 0,
      downloadCount: 0,
      welcomeSent: false,
    };
  }
  return users[userId];
}

function touchUser(users, msg) {
  const userId = getUserId(msg);
  const now = new Date().toISOString();

  const user = getUserRecord(users, userId);

  if (!user.firstSeen) {
    user.firstSeen = now;
  }

  user.lastSeen = now;
  user.messageCount = Number(user.messageCount || 0) + 1;

  return user;
}

function incrementDownload(users, msg) {
  const userId = getUserId(msg);
  const user = getUserRecord(users, userId);
  user.downloadCount = Number(user.downloadCount || 0) + 1;
  user.lastSeen = new Date().toISOString();
  return user;
}

function markWelcomeSent(users, msg) {
  const userId = getUserId(msg);
  const user = getUserRecord(users, userId);
  user.welcomeSent = true;
  user.lastSeen = new Date().toISOString();
  return user;
}

function hasSeenWelcome(users, msg) {
  const userId = getUserId(msg);
  const user = getUserRecord(users, userId);
  return !!user.welcomeSent;
}

function getStats(users) {
  const now = Date.now();

  const oneDay = 24 * 60 * 60 * 1000;
  const sevenDays = 7 * oneDay;
  const thirtyDays = 30 * oneDay;

  const allUsers = Object.values(users || {});
  const totalUsers = allUsers.length;

  let dailyUsers = 0;
  let weeklyUsers = 0;
  let monthlyUsers = 0;
  let totalDownloads = 0;
  let totalMessages = 0;

  for (const user of allUsers) {
    totalDownloads += Number(user.downloadCount || 0);
    totalMessages += Number(user.messageCount || 0);

    if (!user.lastSeen) continue;

    const lastSeenTs = new Date(user.lastSeen).getTime();
    if (Number.isNaN(lastSeenTs)) continue;

    if (now - lastSeenTs <= oneDay) dailyUsers++;
    if (now - lastSeenTs <= sevenDays) weeklyUsers++;
    if (now - lastSeenTs <= thirtyDays) monthlyUsers++;
  }

  return {
    totalUsers,
    dailyUsers,
    weeklyUsers,
    monthlyUsers,
    totalDownloads,
    totalMessages,
  };
}

module.exports = {
  loadUsers,
  saveUsers,
  touchUser,
  incrementDownload,
  markWelcomeSent,
  hasSeenWelcome,
  getStats,
};
