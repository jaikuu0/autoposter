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


const fs = require("fs");
const path = require("path");

const DB_DIR = "./data";

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(path.join(DB_DIR, "autoposter.db"));

  /* ===============================
    DATABASE & MIGRATION
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
      console.log("⏳ Updating database: Adding 'owner_id' column...");
      db.exec("ALTER TABLE chats ADD COLUMN owner_id INTEGER");
      console.log("✅ Database updated.");
    }
  } catch (e) {
    console.error("Migration Error:", e.message);
  }

  /* ===============================
    HELPERS & SAFE EDIT
  ================================ */

  const getSetting = (chatId, key, defaultValue) => {
    const row = db.prepare("SELECT value FROM settings WHERE chat_id=? AND key=?").get(chatId, key);
    return row ? row.value : defaultValue;
  };

  const setSetting = (chatId, key, value) => {
    db.prepare("INSERT OR REPLACE INTO settings(chat_id, key, value) VALUES(?,?,?)").run(chatId, key, value);
  };

  // Helper to avoid "Message Not Modified" errors
  const safeEdit = async (ctx, text, extra) => {
      try {
          await ctx.editMessageText(text, extra);
      } catch (e) {
          if (!e.message.includes("message is not modified")) {
              console.error("UI Error:", e.message);
          }
      }
  };

  /* ===============================
    AI ENGINE
  ================================ */

  async function generateHumanContent(post, category) {
    let promptContext = `
  تو یک نویسنده تکنولوژی باحال و باسواد هستی.
  لحن: خودمونی.
  قوانین: فارسی بنویس ولی اصطلاحات تخصصی (API, Bug, Server) رو انگلیسی بنویس.
  آخر مطلب: نظر شخصی بده و سوال بپرس.
  اگر خبر بی‌ارزش بود بنویس: STOP
  `;

    if (category === "ai") {
      promptContext = `تو یک متخصص هوش مصنوعی هستی. لحن: آگاهانه ولی ساده. روی تاثیر خبر تمرکز کن.`;
    } else if (category === "design") {
      promptContext = `تو یک طراح خلاق هستی. لحن: هنری و جذاب. درباره زیبایی‌شناسی نظر بده.`;
    } else if (category === "poetry") {
      promptContext = `تو یک اهل قلم و ادیب هستی. این شعر رو با یک مقدمه احساسی معرفی کن و در مورد معنی کوتاهی توضیح بده. اگر متن نامناسب است بنویس: STOP`;
    } else if (category === "religious") {
      promptContext = `تو یک مشاور روحانی آرام هستی. این متن مذهبی را با لحنی گرم معرفی کن و یک نکته اخلاقی استخراج کن.`;
    }

    const prompt = `
  ${promptContext}

  عنوان/متن اصلی:
  ${post.title}
  ${post.content ? "\n\nمتن بیشتر:\n" + post.content : ""}

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
      console.error("❌ AI Error:", e.response?.data || e.message);
      return null;
    }
  }

  /* ===============================
    SOURCES
  ================================ */

  const sources = {
    programming: {
      label: "💻 برنامه‌نویسی",
      fetch: async () => {
        const pick = Math.random() > 0.5 ? 'hn' : 'dev';
        if (pick === 'hn') {
          try {
            const ids = await axios.get("https://hacker-news.firebaseio.com/v0/topstories.json");
            const id = ids.data[Math.floor(Math.random() * 20)];
            const p = await axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
            if (!p.data || !p.data.title) return null;
            return { title: p.data.title, url: p.data.url, source: "HackerNews" };
          } catch { return null; }
        } else {
          try {
            const res = await axios.get("https://dev.to/api/articles?per_page=20");
            const p = res.data[Math.floor(Math.random() * 20)];
            return { title: p.title, url: p.url, source: "Dev.to" };
          } catch { return null; }
        }
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
          const res = await axios.get("https://api.ganjoor.net/api/ganjoor/poems/random");
          const p = res.data;
          const title = `شعری از ${p.poetName}`;
          const content = p.plainText;
          return { title: title, content: content, url: p.url, source: "گنجور" };
        } catch { return null; }
      }
    },
    religious: {
      label: "🕌 مذهبی",
      fetch: async () => {
        try {
          const res = await axios.get("https://api.alquran.cloud/v1/ayah/random/fa.fooladvand");
          const verse = res.data.data;
          const title = `آیه ${verse.numberInSurah} از سوره ${verse.surah.englishName}`;
          const content = `«${verse.text}»\n\nترجمه: ${verse.translation}`;
          return { title: title, content: content, url: `https://quran.com/${verse.surah.number}/${verse.numberInSurah}`, source: "قرآن کریم" };
        } catch { return null; }
      }
    }
  };

  /* ===============================
    TELEGRAM UI LOGIC
  ================================ */

  bot.command('start', (ctx) => {
    const u = ctx.from;
    db.prepare("INSERT OR REPLACE INTO users(id, first_name, username) VALUES(?,?,?)")
      .run(u.id, u.first_name, u.username);

    const chats = db.prepare("SELECT id FROM chats WHERE owner_id = ?").all(u.id);
    
    if (chats.length > 0) {
        ctx.reply('سلام دوباره! 👋\nکنترل پنل شما آماده است.', 
          Markup.inlineKeyboard([
            [Markup.button.callback("⚙️ مدیریت کانال‌ها", "open_main_menu")],
            [Markup.button.callback("📊 آمار من", "show_analytics")]
          ])
        );
    } else {
        ctx.reply('سلام! ✋\nمن ربات پوستر هوشمند هستم.\n\nبرای شروع، ابتدا مرا در کانال خود **ادمین** کنید، سپس دکمه زیر را بزنید.', 
          Markup.inlineKeyboard([
            [Markup.button.callback("🔄 بررسی کانال‌ها", "open_main_menu")]
          ])
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
      console.log(`✅ User ${actor.id} added bot to ${chat.title}`);
    } else {
      db.prepare("DELETE FROM chats WHERE id=?").run(chat.id);
      db.prepare("DELETE FROM settings WHERE chat_id=?").run(chat.id);
    }
  });

  // --- Menu Renderers ---

  async function openMainMenu(ctx) {
    const userId = ctx.from.id;
    const chats = db.prepare("SELECT id, title FROM chats WHERE owner_id = ?").all(userId);
    
    if (chats.length === 0) {
        const text = "⚠️ کانالی یافت نشد. لطفا بات را در کانال ادمین کنید.";
        if (ctx.callbackQuery) return safeEdit(ctx, text);
        return ctx.reply(text);
    }

    const buttons = chats.map(c => [
      Markup.button.callback(`📝 ${c.title}`, `manage_${c.id}`)
    ]);

    await safeEdit(ctx, "📋 **لیست کانال‌های شما:**", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
  }

  async function renderSettingsMenu(ctx, chatId) {
      const userId = ctx.from.id;
      const chatInfo = db.prepare("SELECT title FROM chats WHERE id=? AND owner_id=?").get(chatId, userId);
      if (!chatInfo) return safeEdit(ctx, "🚫 خطا: دسترسی ندارید.");
    
      const interval = getSetting(chatId, "interval", "3600");
      const status = getSetting(chatId, "enabled", "1");
      const statusText = status === "1" ? "✅ روشن" : "❌ خاموش";
    
      let displayTime = interval < 60 ? `${interval} ثانیه` : `${interval / 60} دقیقه`;
    
      await safeEdit(ctx, `⚙️ تنظیمات: <b>${chatInfo.title}</b>`, {
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
      const currentTopics = getSetting(chatId, "topics", "programming").split(',');
      
      const buttons = Object.keys(sources).map(key => {
          const isActive = currentTopics.includes(key);
          const label = sources[key].label;
          const text = isActive ? `✅ ${label}` : label;
          return [Markup.button.callback(text, `tp_${key}_${chatId}`)];
      });
    
      buttons.push([Markup.button.callback("« بازگشت", `manage_${chatId}`)]);
    
      await safeEdit(ctx, "🎭 انتخاب موضوعات:\n(می‌توانید چند مورد را انتخاب کنید)", {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons)
      });
  }

  // --- Actions ---

  bot.action('open_main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    openMainMenu(ctx);
  });

  bot.action('show_analytics', async (ctx) => {
    await ctx.answerCbQuery();
    // Analytics logic...
    ctx.reply("بخش آمار به زودی...");
  });

  bot.action(/manage_(-?\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.match[1];
    await renderSettingsMenu(ctx, chatId);
  });

  bot.action(/topics_(-?\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.match[1];
    await renderTopicsMenu(ctx, chatId);
  });

  // Toggle Topic
  bot.action(/tp_([a-z]+)_(-?\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const topic = ctx.match[1];
    const chatId = ctx.match[2];

    let currentTopics = getSetting(chatId, "topics", "programming").split(',');
    
    if (currentTopics.includes(topic)) {
        currentTopics = currentTopics.filter(t => t !== topic);
    } else {
        currentTopics.push(topic);
    }

    // Ensure at least one topic is selected
    if (currentTopics.length === 0) currentTopics.push('programming');

    setSetting(chatId, "topics", currentTopics.join(','));
    
    // Re-render
    await renderTopicsMenu(ctx, chatId);
  });

  bot.action(/toggle_(-?\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.match[1];
    
    const current = getSetting(chatId, "enabled", "1");
    const newStatus = current === "1" ? "0" : "1";
    setSetting(chatId, "enabled", newStatus);
    
    await renderSettingsMenu(ctx, chatId);
  });

  bot.action(/change_time_(-?\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.match[1];

    const current = parseInt(getSetting(chatId, "interval", "3600"));
    const times = [10, 1800, 3600, 7200]; // 10s, 30m, 60m, 120m
    const next = times[(times.indexOf(current) + 1) % times.length];
    setSetting(chatId, "interval", next.toString());

    await renderSettingsMenu(ctx, chatId);
  });

  bot.action(/delete_(-?\d+)/, async (ctx) => {
    await ctx.answerCbQuery("حذف شد");
    const chatId = ctx.match[1];
    db.prepare("DELETE FROM chats WHERE id=?").run(chatId);
    db.prepare("DELETE FROM settings WHERE chat_id=?").run(chatId);
    openMainMenu(ctx);
  });

  /* ===============================
    REACTIONS
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
    if (enabled !== "1") return { status: "disabled" };

    const topicsStr = getSetting(chatId, "topics", "programming");
    const topics = topicsStr.split(',');

    // Pick random topic from active ones
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];
    const sourceObj = sources[randomTopic];

    if (!sourceObj) return { status: "no_source" };

    const post = await sourceObj.fetch();
    if (!post) return { status: "fetch_error" };

    // Check Duplicate
    const h = crypto.createHash("sha256").update(post.url || post.title).digest("hex");
    const exists = db.prepare("SELECT id FROM posts WHERE hash=?").get(h);
    if (exists) return { status: "duplicate" };

    const text = await generateHumanContent(post, randomTopic);
    
    if (!text) return { status: "ai_error" };
    if (text.includes("STOP")) return { status: "rejected" };

    try {
      const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
      db.prepare("INSERT INTO posts(chat_id, message_id, source, title, hash) VALUES(?,?,?,?,?)")
        .run(chatId, sent.message_id, sourceObj.label, post.title, h);
      return { status: "success" };
    } catch (err) {
      return { status: "send_error" };
    }
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
            if (res.status === "success") console.log(`✅ [${c.id}] Posted`);
            else if (res.status === "duplicate") {} // Silent skip
            else console.log(`⚠️ [${c.id}] ${res.status}`);
        });
      }
    }
  }, 10000);

  /* ===============================
    START
  ================================ */

  bot.catch((err, ctx) => {
    // Ignore "message not modified" to keep console clean
    if (!err.message.includes("message is not modified")) {
      console.error(`Global Error: ${err.message}`);
    }
  });

  bot.launch().then(() => {
      console.log("🤖 Bot Started!");
      console.log("📊 Loaded " + db.prepare("SELECT count(*) as c FROM chats").get().c + " channels.");
  }).catch(err => console.error(err));

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
