require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const Parser = require("rss-parser");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const parser = new Parser();

/* ===============================
   CONFIG
================================ */

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AI_KEY = process.env.OPENROUTER_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Use Service Role Key for backend

if (!TG_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing environment variables!");
}

const bot = new Telegraf(TG_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ===============================
   HELPERS & DB WRAPPERS
================================ */

// Helper for safe UI edits
const safeEdit = async (ctx, text, extra) => {
  try {
    await ctx.editMessageText(text, extra);
  } catch (e) {
    if (!e.message.includes("message is not modified")) {
      console.error("UI Error:", e.message);
    }
  }
};

// Get Setting (Async)
const getSetting = async (chatId, key, defaultValue) => {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("chat_id", chatId)
    .eq("key", key)
    .single();

  if (error || !data) return defaultValue;
  return data.value;
};

// Set Setting (Async)
const setSetting = async (chatId, key, value) => {
  await supabase
    .from("settings")
    .upsert({ chat_id: chatId, key, value }, { onConflict: ['chat_id', 'key'] });
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

  if (category === "ai") promptContext = `متخصص هوش مصنوعی هستی. روی تاثیر خبر تمرکز کن.`;
  else if (category === "design") promptContext = `طراح خلاق هستی. درباره زیبایی‌شناسی نظر بده.`;
  else if (category === "poetry") promptContext = `ادیب و اهل قلم هستی. شعر رو با مقدمه احساسی معرفی کن.`;
  else if (category === "religious") promptContext = `مشاور روحانی آرام هستی. نکته اخلاقی استخراج کن.`;

  const prompt = `${promptContext}\n\nعنوان/متن:\n${post.title}\n${post.content ? "\n" + post.content : ""}\n\nمنبع: ${post.source}`;

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
   SOURCES
================================ */

const sources = {
  programming: {
    label: "💻 برنامه‌نویسی",
    fetch: async () => {
      try {
        // Prefer Dev.to for reliability
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
   TELEGRAM UI LOGIC
================================ */

bot.command('start', async (ctx) => {
  const u = ctx.from;
  
  // Upsert User
  await supabase.from("users").upsert({ id: u.id, first_name: u.first_name, username: u.username });

  // Check for chats
  const { data: chats } = await supabase.from("chats").select("id").eq("owner_id", u.id);
  
  if (chats && chats.length > 0) {
    ctx.reply('سلام دوباره! 👋\nکنترل پنل شما آماده است.', 
      Markup.inlineKeyboard([
        [Markup.button.callback("⚙️ مدیریت کانال‌ها", "open_main_menu")],
        [Markup.button.callback("📊 آمار من", "show_analytics")]
      ])
    );
  } else {
    ctx.reply('سلام! ✋\nمن ربات پوستر هوشمند هستم.\n\nبرای شروع، ابتدا مرا در کانال خود **ادمین** کنید، سپس دکمه زیر را بزنید.', 
      Markup.inlineKeyboard([ [Markup.button.callback("🔄 بررسی کانال‌ها", "open_main_menu")] ])
    );
  }
});

bot.on('my_chat_member', async (ctx) => {
  const chat = ctx.myChatMember.chat;
  const actor = ctx.myChatMember.from; 
  const status = ctx.myChatMember.new_chat_member.status;
  
  if (status === 'administrator' || status === 'member') {
    // Ensure user exists first
    await supabase.from("users").upsert({ id: actor.id, first_name: actor.first_name });
    
    // Add chat
    await supabase.from("chats").upsert({ 
      id: chat.id, 
      owner_id: actor.id, 
      title: chat.title || "Private", 
      type: chat.type 
    });
    console.log(`✅ User ${actor.id} added bot to ${chat.title}`);
  } else {
    // Bot removed
    await supabase.from("chats").delete().eq("id", chat.id);
    await supabase.from("settings").delete().eq("chat_id", chat.id);
  }
});

// --- Menu Renderers ---

async function openMainMenu(ctx) {
  const userId = ctx.from.id;
  const { data: chats } = await supabase.from("chats").select("id, title").eq("owner_id", userId);
  
  if (!chats || chats.length === 0) {
    const text = "⚠️ کانالی یافت نشد. لطفا بات را در کانال ادمین کنید.";
    if (ctx.callbackQuery) return safeEdit(ctx, text);
    return ctx.reply(text);
  }

  const buttons = chats.map(c => [Markup.button.callback(`📝 ${c.title}`, `manage_${c.id}`)]);
  await safeEdit(ctx, "📋 **لیست کانال‌های شما:**", { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
}

async function renderSettingsMenu(ctx, chatId) {
  const userId = ctx.from.id;
  
  // Verify ownership
  const { data: chatInfo } = await supabase.from("chats").select("title").eq("id", chatId).eq("owner_id", userId).single();
  if (!chatInfo) return safeEdit(ctx, "🚫 خطا: دسترسی ندارید.");

  const interval = await getSetting(chatId, "interval", "3600");
  const status = await getSetting(chatId, "enabled", "1");
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
  let currentTopicsStr = await getSetting(chatId, "topics", "programming");
  let currentTopics = currentTopicsStr.split(',');
  
  const buttons = Object.keys(sources).map(key => {
      const isActive = currentTopics.includes(key);
      return [Markup.button.callback(isActive ? `✅ ${sources[key].label}` : sources[key].label, `tp_${key}_${chatId}`)];
  });
  buttons.push([Markup.button.callback("« بازگشت", `manage_${chatId}`)]);

  await safeEdit(ctx, "🎭 انتخاب موضوعات:", { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
}

// --- Actions ---

bot.action('open_main_menu', async (ctx) => { await ctx.answerCbQuery(); openMainMenu(ctx); });
bot.action('show_analytics', async (ctx) => { await ctx.answerCbQuery(); ctx.reply("به زودی..."); });

bot.action(/manage_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  await renderSettingsMenu(ctx, ctx.match[1]);
});

bot.action(/topics_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  await renderTopicsMenu(ctx, ctx.match[1]);
});

bot.action(/tp_([a-z]+)_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const topic = ctx.match[1];
  const chatId = ctx.match[2];

  let currentTopics = (await getSetting(chatId, "topics", "programming")).split(',');
  
  if (currentTopics.includes(topic)) currentTopics = currentTopics.filter(t => t !== topic);
  else currentTopics.push(topic);

  if (currentTopics.length === 0) currentTopics.push("programming"); // Safety

  await setSetting(chatId, "topics", currentTopics.join(','));
  await renderTopicsMenu(ctx, chatId);
});

bot.action(/toggle_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.match[1];
  const current = await getSetting(chatId, "enabled", "1");
  await setSetting(chatId, "enabled", current === "1" ? "0" : "1");
  await renderSettingsMenu(ctx, chatId);
});

bot.action(/change_time_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.match[1];
  const current = parseInt(await getSetting(chatId, "interval", "3600"));
  const times = [10, 1800, 3600, 7200]; 
  const next = times[(times.indexOf(current) + 1) % times.length];
  await setSetting(chatId, "interval", next.toString());
  await renderSettingsMenu(ctx, chatId);
});

bot.action(/delete_(-?\d+)/, async (ctx) => {
  await ctx.answerCbQuery("حذف شد");
  const chatId = ctx.match[1];
  await supabase.from("chats").delete().eq("id", chatId);
  await supabase.from("settings").delete().eq("chat_id", chatId);
  openMainMenu(ctx);
});

/* ===============================
   REACTIONS
================================ */

bot.on('message_reaction', async (ctx) => {
  const chatId = ctx.chat.id;
  const messageId = ctx.update.message_reaction.message_id;
  const reactions = ctx.update.message_reaction.new_reaction;

  const { data: post } = await supabase.from("posts").select("id").eq("chat_id", chatId).eq("message_id", messageId).single();
  if (!post) return;

  let incPos = 0, incNeg = 0;
  reactions.forEach(r => {
    if (r.emoji === '👍' || r.emoji === '🔥' || r.emoji === '❤️') incPos = 1;
    if (r.emoji === '👎') incNeg = 1;
  });

  // Note: This is a simplified update. For high volume, use Postgres Functions (RPC).
  if (incPos > 0) {
     const { data: current } = await supabase.from("posts").select("reactions_positive").eq("id", post.id).single();
     if(current) await supabase.from("posts").update({ reactions_positive: current.reactions_positive + 1 }).eq("id", post.id);
  }
  if (incNeg > 0) {
     const { data: current } = await supabase.from("posts").select("reactions_negative").eq("id", post.id).single();
     if(current) await supabase.from("posts").update({ reactions_negative: current.reactions_negative + 1 }).eq("id", post.id);
  }
});

/* ===============================
   SCHEDULER (Smart Retry)
================================ */

async function postToChat(chatId) {
  const enabled = await getSetting(chatId, "enabled", "1");
  if (enabled !== "1") return { status: "disabled" };

  // 1. Get & Validate Topics
  let topicsStr = await getSetting(chatId, "topics", "programming");
  let topics = topicsStr.split(',');
  const validKeys = Object.keys(sources);
  topics = topics.filter(t => validKeys.includes(t));
  if (topics.length === 0) topics = ["programming"];
  topics.sort(() => Math.random() - 0.5); // Shuffle

  // 2. Try Each Topic
  for (const topic of topics) {
    const sourceObj = sources[topic];
    const post = await sourceObj.fetch();
    if (!post) continue;

    const h = crypto.createHash("sha256").update(post.url || post.title).digest("hex");
    
    // Check Duplicate
    const { data: exists } = await supabase.from("posts").select("id").eq("hash", h).single();
    if (exists) continue;

    const text = await generateHumanContent(post, topic);
    if (!text || text.includes("STOP")) continue;

    try {
      const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
      await supabase.from("posts").insert({
        chat_id: chatId,
        message_id: sent.message_id,
        source: sourceObj.label,
        title: post.title,
        hash: h
      });
      return { status: "success", topic: topic };
    } catch (err) {
      console.log(`❌ Send Error: ${err.message}`);
      return { status: "send_error" };
    }
  }

  return { status: "all_failed" };
}

setInterval(async () => {
  const { data: chats } = await supabase.from("chats").select("id");
  if (!chats) return;

  const now = Math.floor(Date.now() / 1000);

  for (const c of chats) {
    const interval = parseInt(await getSetting(c.id, "interval", "3600"));
    const lastPost = parseInt(await getSetting(c.id, "last_post_time", "0"));

    if (now - lastPost >= interval) {
      await setSetting(c.id, "last_post_time", now.toString());
      
      postToChat(c.id).then(res => {
        if (res.status === "success") console.log(`✅ [${c.id}] Posted from ${res.topic}`);
        else if (res.status === "all_failed") console.log(`🚫 [${c.id}] All sources failed.`);
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

bot.launch().then(() => console.log("🤖 Bot Started with Supabase!")).catch(err => console.error(err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
