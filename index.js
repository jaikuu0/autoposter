require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const Parser = require("rss-parser");
const Database = require("better-sqlite3");
const crypto = require("crypto");

// Configure Parser with User Agent to avoid blocking
const parser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
});

/* ===============================
   CONFIG
================================ */

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.OPENROUTER_API_KEY;

// if (!TG_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required!");

const bot = new Telegraf(TG_TOKEN);
const db = new Database("autoposter.db");

/* ===============================
   DATABASE
================================ */

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

try {
  const columns = db.prepare("PRAGMA table_info(chats)").all();
  const hasOwnerId = columns.some(col => col.name === 'owner_id');
  if (!hasOwnerId) {
    db.exec("ALTER TABLE chats ADD COLUMN owner_id INTEGER");
  }
} catch (e) { console.error("Migration Error:", e.message); }

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

const safeEdit = async (ctx, text, extra) => {
    try {
        await ctx.editMessageText(text, extra);
    } catch (e) {
        if (!e.message.includes("message is not modified")) {
            // console.error("UI Error:", e.message);
        }
    }
};

/* ===============================
   AI ENGINE
================================ */

async function generateHumanContent(post, category) {
  let promptContext = `تو یک نویسنده تکنولوژی باحال و باسواد هستی. فارسی بنویس ولی اصطلاحات تخصصی انگلیسی باشن. آخر مطلب نظر بده و سوال بپرس. اگر بی ارزش بود بنویس STOP`;
  
  if (category === "ai") promptContext = `متخصص هوش مصنوعی هستی. روی تاثیر خبر تمرکز کن.`;
  else if (category === "design") promptContext = `طراح خلاق هستی. درباره زیبایی‌شناسی نظر بده.`;
  else if (category === "poetry") promptContext = `ادیب و اهل قلم هستی. شعر رو با مقدمه احساسی معرفی کن.`;
  else if (category === "religious") promptContext = `مشاور روحانی آرام هستی. نکته اخلاقی استخراج کن.`;

  const prompt = `${promptContext}\n\nعنوان/متن:\n${post.title}\n${post.content ? "\n"+post.content : ""}\n\nمنبع: ${post.source}`;

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: "arcee-ai/trinity-large-preview:free", messages: [{ role: "user", content: prompt }] },
      { headers: { Authorization: `Bearer ${AI_KEY}`, "Content-Type": "application/json" } }
    );
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    console.error("❌ AI Error:", e.response?.data || e.message);
    return null;
  }
}

/* ===============================
   SOURCES (Robust Fetching)
================================ */

const sources = {
  programming: {
    label: "💻 برنامه‌نویسی",
    fetch: async () => {
      // Prefer Dev.to as it's more reliable for random picks
      try {
        const res = await axios.get("https://dev.to/api/articles?per_page=30", { timeout: 5000 });
        const p = res.data[Math.floor(Math.random() * res.data.length)];
        return { title: p.title, url: p.url, source: "Dev.to" };
      } catch { return null; }
    }
  },
  ai: {
    label: "🤖 هوش مصنوعی",
    fetch: async () => {
      try {
        const feed = await parser.parseURL("https://www.artificialintelligence-news.com/feed/");
        const item = feed.items[Math.floor(Math.random() * feed.items.length)];
        return { title: item.title, url: item.link, source: "AI News" };
      } catch { return null; }
    }
  },
  design: {
    label: "🎨 طراحی",
    fetch: async () => {
      try {
        const feed = await parser.parseURL("https://design-milk.com/feed/");
        const item = feed.items[Math.floor(Math.random() * feed.items.length)];
        return { title: item.title, url: item.link, source: "Design Milk" };
      } catch { return null; }
    }
  },
  poetry: {
    label: "📜 شعر و ادب",
    fetch: async () => {
      try {
        const res = await axios.get("https://api.ganjoor.net/api/ganjoor/poems/random", { timeout: 5000 });
        const p = res.data;
        return { title: `شعری از ${p.poetName}`, content: p.plainText, url: p.url, source: "گنجور" };
      } catch { return null; }
    }
  },
  religious: {
    label: "🕌 مذهبی",
    fetch: async () => {
      try {
        const res = await axios.get("https://api.alquran.cloud/v1/ayah/random/fa.fooladvand", { timeout: 5000 });
        const verse = res.data.data;
        return { title: `آیه ${verse.numberInSurah} سوره ${verse.surah.englishName}`, content: `«${verse.text}»\nترجمه: ${verse.translation}`, source: "قرآن" };
      } catch { return null; }
    }
  }
};

/* ===============================
   TELEGRAM UI
================================ */

bot.command('start', (ctx) => {
  const u = ctx.from;
  db.prepare("INSERT OR REPLACE INTO users(id, first_name, username) VALUES(?,?,?)").run(u.id, u.first_name, u.username);

  const chats = db.prepare("SELECT id FROM chats WHERE owner_id = ?").all(u.id);
  if (chats.length > 0) {
      ctx.reply('سلام دوباره! 👋\nکنترل پنل:', 
        Markup.inlineKeyboard([
          [Markup.button.callback("⚙️ مدیریت کانال‌ها", "open_main_menu")],
          [Markup.button.callback("📊 آمار", "show_analytics")]
        ])
      );
  } else {
      ctx.reply('سلام! ✋\nمن ربات پوستر هوشمند هستم.\nابتدا مرا در کانال ادمین کنید، سپس دکمه زیر را بزنید.', 
        Markup.inlineKeyboard([ [Markup.button.callback("🔄 بررسی", "open_main_menu")] ])
      );
  }
});

bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.myChatMember.chat;
  const actor = ctx.myChatMember.from; 
  const status = ctx.myChatMember.new_chat_member.status;
  
  if (status === 'administrator' || status === 'member') {
    db.prepare("INSERT OR IGNORE INTO users(id, first_name) VALUES(?,?)").run(actor.id, actor.first_name);
    db.prepare("INSERT OR REPLACE INTO chats(id, owner_id, title, type) VALUES(?,?,?,?)")
      .run(chat.id, actor.id, chat.title || "Private", chat.type);
    console.log(`✅ Added to ${chat.title}`);
  } else {
    db.prepare("DELETE FROM chats WHERE id=?").run(chat.id);
    db.prepare("DELETE FROM settings WHERE chat_id=?").run(chat.id);
  }
});

async function openMainMenu(ctx) {
  const userId = ctx.from.id;
  const chats = db.prepare("SELECT id, title FROM chats WHERE owner_id = ?").all(userId);
  if (chats.length === 0) return safeEdit(ctx, "⚠️ کانالی یافت نشد.");
  const buttons = chats.map(c => [Markup.button.callback(`📝 ${c.title}`, `manage_${c.id}`)]);
  await safeEdit(ctx, "📋 **لیست کانال‌ها:**", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
}

async function renderSettingsMenu(ctx, chatId) {
    const chatInfo = db.prepare("SELECT title FROM chats WHERE id=? AND owner_id=?").get(chatId, ctx.from.id);
    if (!chatInfo) return safeEdit(ctx, "🚫 خطا.");
    const interval = getSetting(chatId, "interval", "3600");
    const status = getSetting(chatId, "enabled", "1");
    const statusText = status === "1" ? "✅ روشن" : "❌ خاموش";
    let displayTime = interval < 60 ? `${interval} ثانیه` : `${interval / 60} دقیقه`;
    await safeEdit(ctx, `⚙️ <b>${chatInfo.title}</b>`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`وضعیت: ${statusText}`, `toggle_${chatId}`)],
        [Markup.button.callback(`⏱ زمان: ${displayTime}`, `change_time_${chatId}`)],
        [Markup.button.callback(`🎭 موضوعات`, `topics_${chatId}`)],
        [Markup.button.callback("🗑 حذف", `delete_${chatId}`)],
        [Markup.button.callback("« بازگشت", "open_main_menu")]
      ])
    });
}

async function renderTopicsMenu(ctx, chatId) {
    let currentTopics = getSetting(chatId, "topics", "programming").split(',');
    if(currentTopics.length === 1 && currentTopics[0] === "") currentTopics = ["programming"]; // Safety Fix
    
    const buttons = Object.keys(sources).map(key => {
        const isActive = currentTopics.includes(key);
        return [Markup.button.callback(isActive ? `✅ ${sources[key].label}` : sources[key].label, `tp_${key}_${chatId}`)];
    });
    buttons.push([Markup.button.callback("✅ ذخیره و بازگشت", `manage_${chatId}`)]);
    await safeEdit(ctx, "🎭 موضوعات فعال:", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
}

// Actions
bot.action('open_main_menu', async (ctx) => { await ctx.answerCbQuery(); openMainMenu(ctx); });
bot.action('show_analytics', async (ctx) => { await ctx.answerCbQuery(); ctx.reply("به زودی..."); });
bot.action(/manage_(-?\d+)/, async (ctx) => { await ctx.answerCbQuery(); renderSettingsMenu(ctx, ctx.match[1]); });
bot.action(/topics_(-?\d+)/, async (ctx) => { await ctx.answerCbQuery(); renderTopicsMenu(ctx, ctx.match[1]); });

bot.action(/tp_([a-z]+)_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const topic = ctx.match[1];
  const chatId = ctx.match[2];
  let currentTopics = getSetting(chatId, "topics", "programming").split(',');
  
  if (currentTopics.includes(topic)) currentTopics = currentTopics.filter(t => t !== topic);
  else currentTopics.push(topic);

  if (currentTopics.length === 0) currentTopics.push("programming"); // Safety: Keep at least one
  
  setSetting(chatId, "topics", currentTopics.join(','));
  await renderTopicsMenu(ctx, chatId);
});

bot.action(/toggle_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.match[1];
  const current = getSetting(chatId, "enabled", "1");
  setSetting(chatId, "enabled", current === "1" ? "0" : "1");
  renderSettingsMenu(ctx, chatId);
});

bot.action(/change_time_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.match[1];
  const current = parseInt(getSetting(chatId, "interval", "3600"));
  const times = [10, 1800, 3600, 7200]; // 10s, 30m, 60m, 120m
  const next = times[(times.indexOf(current) + 1) % times.length];
  setSetting(chatId, "interval", next.toString());
  renderSettingsMenu(ctx, chatId);
});

bot.action(/delete_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery("حذف شد");
  db.prepare("DELETE FROM chats WHERE id=?").run(ctx.match[1]);
  openMainMenu(ctx);
});

/* ===============================
   REACTIONS
================================ */

bot.on('message_reaction', async (ctx) => {
  const chatId = ctx.chat.id;
  const messageId = ctx.update.message_reaction.message_id;
  const post = db.prepare("SELECT id FROM posts WHERE chat_id=? AND message_id=?").get(chatId, messageId);
  if (!post) return;
  const reactions = ctx.update.message_reaction.new_reaction;
  reactions.forEach(r => {
    if (r.emoji === '👍' || r.emoji === '🔥' || r.emoji === '❤️') 
      db.prepare("UPDATE posts SET reactions_positive = reactions_positive + 1 WHERE id=?").run(post.id);
    if (r.emoji === '👎') 
      db.prepare("UPDATE posts SET reactions_negative = reactions_negative + 1 WHERE id=?").run(post.id);
  });
});

/* ===============================
   SCHEDULER (Smart Retry)
================================ */

async function postToChat(chatId) {
  // 1. Get Topics
  let topicsStr = getSetting(chatId, "topics", "programming");
  let topics = topicsStr.split(',');
  
  // Safety: Ensure topics are valid keys
  const validKeys = Object.keys(sources);
  topics = topics.filter(t => validKeys.includes(t));
  if (topics.length === 0) topics = ["programming"]; 

  // 2. Try Each Topic until success
  // Shuffle topics to rotate sources
  topics.sort(() => Math.random() - 0.5);

  for (const topic of topics) {
      const sourceObj = sources[topic];
      
      // Fetch
      const post = await sourceObj.fetch();
      if (!post) continue; // Try next topic

      // Duplicate Check
      const h = crypto.createHash("sha256").update(post.url || post.title).digest("hex");
      const exists = db.prepare("SELECT id FROM posts WHERE hash=?").get(h);
      if (exists) continue; // Try next topic

      // Generate AI
      const text = await generateHumanContent(post, topic);
      if (!text || text.includes("STOP")) continue; // Try next topic

      // Send
      try {
        const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
        db.prepare("INSERT INTO posts(chat_id, message_id, source, title, hash) VALUES(?,?,?,?,?)")
          .run(chatId, sent.message_id, sourceObj.label, post.title, h);
        return { status: "success", topic: topic };
      } catch (err) {
        console.log(`❌ Send Error: ${err.message}`);
        return { status: "send_error" };
      }
  }

  return { status: "all_failed" };
}

setInterval(async () => {
  const chats = db.prepare("SELECT id FROM chats").all();
  const now = Math.floor(Date.now() / 1000);

  for (const c of chats) {
    const interval = parseInt(getSetting(c.id, "interval", "3600"));
    const lastPost = parseInt(getSetting(c.id, "last_post_time", "0"));

    if (now - lastPost >= interval) {
      setSetting(c.id, "last_post_time", now.toString());
      
      postToChat(c.id).then(res => {
          if (res.status === "success") console.log(`✅ [${c.id}] Posted from ${res.topic}`);
          else if (res.status === "all_failed") console.log(`🚫 [${c.id}] All sources failed or duplicate.`);
      });
    }
  }
}, 10000);

/* ===============================
   START
================================ */

bot.catch((err) => {
  if (!err.message.includes("message is not modified")) console.error(`Error:`, err.message);
});

bot.launch().then(() => console.log("🤖 Bot Started & Stable.")).catch(err => console.error(err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
