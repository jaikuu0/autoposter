require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const Parser = require("rss-parser");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const parser = new Parser();

/* ===============================
   CONFIG
================================ */

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.OPENROUTER_API_KEY;

if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required!");

const bot = new Telegraf(TG_TOKEN);
const db = new Database("autoposter.db");

/* ===============================
   DATABASE & MIGRATION (FIX)
================================ */

// 1. Create tables (Basic structure)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, 
    first_name TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY, 
    title TEXT,
    type TEXT,
    enabled INTEGER DEFAULT 1
  );
  
  CREATE TABLE IF NOT EXISTS settings (
    chat_id INTEGER,
    key TEXT,
    value TEXT,
    PRIMARY KEY (chat_id, key)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY, 
    chat_id INTEGER,
    message_id INTEGER,
    source TEXT,
    title TEXT,
    hash TEXT,
    reactions_positive INTEGER DEFAULT 0,
    reactions_negative INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 2. Migration: Check if 'owner_id' exists, if not add it.
try {
  const columns = db.prepare("PRAGMA table_info(chats)").all();
  const hasOwnerId = columns.some(col => col.name === 'owner_id');
  
  if (!hasOwnerId) {
    console.log("⏳ Updating database: Adding 'owner_id' column...");
    db.exec("ALTER TABLE chats ADD COLUMN owner_id INTEGER");
    console.log("✅ Database updated.");
  }
} catch (e) {
  console.error("Migration Error:", e.message);
}

/* ===============================
   HELPERS
================================ */

const getSetting = (chatId, key, defaultValue) => {
  const row = db.prepare("SELECT value FROM settings WHERE chat_id=? AND key=?").get(chatId, key);
  return row ? row.value : defaultValue;
};

const setSetting = (chatId, key, value) => {
  db.prepare("INSERT OR REPLACE INTO settings(chat_id, key, value) VALUES(?,?,?)").run(chatId, key, value);
};

/* ===============================
   AI ENGINE
================================ */

async function generateHumanContent(post) {
  const prompt = `
تو یک منتقد و نویسنده تکنولوژی هستی. 
وظیفه تو تصمیم‌گیری نهایی است.

قوانین سخت‌گیرانه (REJECTION):
- اگر مطلب تبلیغاتی، خبر استخدام، فاندینگ گیری، همکاری تجاری، خبر رسمی شرکت (PR)، یا چیز بی‌ارزش است -> بنویس: STOP
- اگر مطلب فقط یک "عنوان جذاب" ولی محتوای خالی دارد -> بنویس: STOP

اگر مطلب ارزشمند بود:
یک پست کوتاه و انسانی بنویس.
- لحن: خودمونی، مثل یک متخصص که با دوستش حرف می‌زنه.
- نترس که نظر شخصی بدهی.
- خلاصه و مفید بنویس.
- هیچ‌وقت لینک ننویس.
- آخر مطلب یه سوال بپرس تا بحث داغ بشه.

عنوان:
 ${post.title}

منبع:
 ${post.source}
`;

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "arcee-ai/trinity-large-preview:free", 
        messages: [{ role: "user", content: prompt }],
      },
      { headers: { Authorization: `Bearer ${AI_KEY}`, "Content-Type": "application/json" } }
    );
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    console.error("AI Error:", e.response?.data || e.message);
    return null;
  }
}

/* ===============================
   SOURCES
================================ */

const sources = {
  HackerNews: {
    fetch: async () => {
      try {
        const ids = await axios.get("https://hacker-news.firebaseio.com/v0/topstories.json");
        const id = ids.data[Math.floor(Math.random() * 10)];
        const p = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!p.data || !p.data.title) return null;
        return { title: p.data.title, url: p.data.url, source: "HackerNews" };
      } catch { return null; }
    }
  },
  DevTo: {
    fetch: async () => {
      try {
        const res = await axios.get("https://dev.to/api/articles?per_page=10");
        const p = res.data[Math.floor(Math.random() * 10)];
        return { title: p.title, url: p.url, source: "Dev.to" };
      } catch { return null; }
    }
  }
};

function pickSource() {
  const keys = Object.keys(sources);
  return keys[Math.floor(Math.random() * keys.length)];
}

/* ===============================
   TELEGRAM UI & LOGIC
================================ */

// 1. Save User on Start
bot.command('start', (ctx) => {
  const u = ctx.from;
  db.prepare("INSERT OR REPLACE INTO users(id, first_name, username) VALUES(?,?,?)")
    .run(u.id, u.first_name, u.username);

  ctx.reply('سلام! ✋\nبه ربات هوشمند خوش اومدی.\n\nبا استفاده از دکمه زیر می‌تونی کانال‌هات رو مدیریت کنی.', 
    Markup.inlineKeyboard([
      [Markup.button.callback("⚙️ مدیریت کانال‌ها", "open_main_menu")],
      [Markup.button.callback("📊 آمار من", "show_analytics")]
    ])
  );
});

// 2. Handle Bot being added to a Channel/Group
bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.myChatMember.chat;
  const actor = ctx.myChatMember.from; 
  const status = ctx.myChatMember.new_chat_member.status;
  
  if (status === 'administrator' || status === 'member') {
    db.prepare("INSERT OR IGNORE INTO users(id, first_name) VALUES(?,?)").run(actor.id, actor.first_name);

    db.prepare("INSERT OR REPLACE INTO chats(id, owner_id, title, type) VALUES(?,?,?,?)")
      .run(chat.id, actor.id, chat.title || "Private", chat.type);
    
    console.log(`✅ User ${actor.id} added bot to ${chat.title}`);
  } else {
    db.prepare("DELETE FROM chats WHERE id=?").run(chat.id);
    db.prepare("DELETE FROM settings WHERE chat_id=?").run(chat.id);
  }
});

// 3. Settings Menu
async function openMainMenu(ctx) {
  const userId = ctx.from.id;

  const chats = db.prepare("SELECT id, title FROM chats WHERE owner_id = ?").all(userId);
  
  if (chats.length === 0) {
    return ctx.reply("⚠️ شما هنوز هیچ کانالی ثبت نکرده‌اید.\n\nلطفا ابتدا بات را در کانال خود ادمین کنید.");
  }

  const buttons = chats.map(c => [
    Markup.button.callback(`📝 ${c.title}`, `manage_${c.id}`)
  ]);

  try {
    if (ctx.callbackQuery) {
        await ctx.editMessageText("📋 **لیست کانال‌های شما:**", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
    } else {
        await ctx.reply("📋 **لیست کانال‌های شما:**", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
    }
  } catch (e) { console.log("Menu error", e.message); }
}

bot.command('settings', (ctx) => openMainMenu(ctx));

bot.action('open_main_menu', async (ctx) => {
  await ctx.answerCbQuery(); // FIX: Answer immediately
  openMainMenu(ctx);
});

bot.action('show_analytics', async (ctx) => {
  await ctx.answerCbQuery(); // FIX: Answer immediately
  const userId = ctx.from.id;
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const stats = db.prepare(`
    SELECT p.source, SUM(p.reactions_positive) as likes, COUNT(p.id) as total
    FROM posts p
    JOIN chats c ON p.chat_id = c.id
    WHERE c.owner_id = ? AND p.created_at >= ?
    GROUP BY p.source
  `).all(userId, oneWeekAgo);

  if (stats.length === 0) return ctx.reply("داده‌ای برای نمایش وجود ندارد.");
  
  let msg = "📊 **آمار هفتگی شما:**\n\n";
  stats.forEach(s => { msg += `🔹 ${s.source}: ${s.total} پست | 👍 ${s.likes}\n`; });
  ctx.reply(msg, { parse_mode: "Markdown" });
});

// --- Management Actions ---

bot.action(/manage_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery(); // FIX: Answer immediately
  const chatId = ctx.match[1];
  const userId = ctx.from.id;

  const chatInfo = db.prepare("SELECT title FROM chats WHERE id=? AND owner_id=?").get(chatId, userId);
  if (!chatInfo) return ctx.editMessageText("🚫 خطا: شما دسترسی به این کانال را ندارید.");

  const interval = getSetting(chatId, "interval", "60");
  const status = getSetting(chatId, "enabled", "1");
  const statusText = status === "1" ? "✅ روشن" : "❌ خاموش";

  await ctx.editMessageText(`⚙️ تنظیمات: <b>${chatInfo.title}</b>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`وضعیت: ${statusText}`, `toggle_${chatId}`)],
      [Markup.button.callback(`⏱ فاصله: ${interval} دقیقه`, `change_time_${chatId}`)],
      [Markup.button.callback("🗑 حذف", `delete_${chatId}`)],
      [Markup.button.callback("« بازگشت", "open_main_menu")]
    ])
  });
});

bot.action(/toggle_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery("✅ تغییر کرد"); // FIX: Answer immediately
  const chatId = ctx.match[1];
  
  const chat = db.prepare("SELECT id FROM chats WHERE id=? AND owner_id=?").get(chatId, ctx.from.id);
  if(!chat) return;

  const current = getSetting(chatId, "enabled", "1");
  const newStatus = current === "1" ? "0" : "1";
  setSetting(chatId, "enabled", newStatus);
  
  const interval = getSetting(chatId, "interval", "60");
  const statusText = newStatus === "1" ? "✅ روشن" : "❌ خاموش";

  await ctx.editMessageText(`⚙️ تنظیمات (آپدیت شد)`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`وضعیت: ${statusText}`, `toggle_${chatId}`)],
      [Markup.button.callback(`⏱ فاصله: ${interval} دقیقه`, `change_time_${chatId}`)],
      [Markup.button.callback("🗑 حذف", `delete_${chatId}`)],
      [Markup.button.callback("« بازگشت", "open_main_menu")]
    ])
  });
});

bot.action(/change_time_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery(); // FIX: Answer immediately
  const chatId = ctx.match[1];
  
  const chat = db.prepare("SELECT id FROM chats WHERE id=? AND owner_id=?").get(chatId, ctx.from.id);
  if(!chat) return;

  const current = parseInt(getSetting(chatId, "interval", "60"));
  const times = [30, 60, 120, 180];
  const next = times[(times.indexOf(current) + 1) % times.length];
  
  setSetting(chatId, "interval", next.toString());

  const status = getSetting(chatId, "enabled", "1");
  const statusText = status === "1" ? "✅ روشن" : "❌ خاموش";

  await ctx.editMessageText(`⚙️ تنظیمات`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`وضعیت: ${statusText}`, `toggle_${chatId}`)],
      [Markup.button.callback(`⏱ فاصله: ${next} دقیقه`, `change_time_${chatId}`)],
      [Markup.button.callback("🗑 حذف", `delete_${chatId}`)],
      [Markup.button.callback("« بازگشت", "open_main_menu")]
    ])
  });
});

bot.action(/delete_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery("حذف شد"); // FIX: Answer immediately
  const chatId = ctx.match[1];
  const chat = db.prepare("SELECT id FROM chats WHERE id=? AND owner_id=?").get(chatId, ctx.from.id);
  if(chat) {
      db.prepare("DELETE FROM chats WHERE id=?").run(chatId);
      db.prepare("DELETE FROM settings WHERE chat_id=?").run(chatId);
  }
  openMainMenu(ctx);
});

/* ===============================
   REACTIONS & ANALYTICS
================================ */

bot.on('message_reaction', async (ctx) => {
  const chatId = ctx.chat.id;
  const messageId = ctx.update.message_reaction.message_id;
  const reactions = ctx.update.message_reaction.new_reaction;

  const post = db.prepare("SELECT * FROM posts WHERE chat_id=? AND message_id=?").get(chatId, messageId);
  if (!post) return;

  reactions.forEach(r => {
    if (r.emoji === '👍' || r.emoji === '🔥' || r.emoji === '❤️') 
      db.prepare("UPDATE posts SET reactions_positive = reactions_positive + 1 WHERE id=?").run(post.id);
    if (r.emoji === '👎') 
      db.prepare("UPDATE posts SET reactions_negative = reactions_negative + 1 WHERE id=?").run(post.id);
  });
});

/* ===============================
   SCHEDULER
================================ */

async function postToChat(chatId) {
  const enabled = getSetting(chatId, "enabled", "1");
  if (enabled !== "1") return;

  const sourceKey = pickSource();
  const sourceObj = sources[sourceKey];
  if (!sourceObj) return;

  const post = await sourceObj.fetch();
  if (!post) return;

  const h = crypto.createHash("sha256").update(post.url || post.title).digest("hex");
  const exists = db.prepare("SELECT id FROM posts WHERE hash=?").get(h);
  if (exists) return;

  const text = await generateHumanContent(post);
  if (!text || text.includes("STOP")) return;

  try {
    const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
    db.prepare("INSERT INTO posts(chat_id, message_id, source, title, hash) VALUES(?,?,?,?,?)")
      .run(chatId, sent.message_id, sourceKey, post.title, h);
    console.log(`✅ Posted to ${chatId}`);
  } catch (err) {
    console.log(`Error sending to ${chatId}:`, err.message);
  }
}

setInterval(async () => {
  const chats = db.prepare("SELECT id FROM chats").all();
  const now = Math.floor(Date.now() / 1000);
  const tasks = [];

  for (const c of chats) {
    const interval = parseInt(getSetting(c.id, "interval", "60"));
    const lastPost = parseInt(getSetting(c.id, "last_post_time", "0"));

    if (now - lastPost >= (interval * 60)) {
      setSetting(c.id, "last_post_time", now.toString());
      tasks.push(postToChat(c.id));
    }
  }

  if (tasks.length > 0) {
    console.log(`🚀 Posting to ${tasks.length} chats...`);
    await Promise.all(tasks);
  }

}, 1 * 150);

/* ===============================
   START & ERROR HANDLING
================================ */

bot.catch((err, ctx) => {
  console.error(`Global Error: ${err.message}`);
});

bot.launch().then(() => console.log("🤖 Bot Started!")).catch(err => console.error(err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));