require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const token = process.env.BOT_TOKEN;
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI;

// Render ផ្តល់ RENDER_EXTERNAL_URL ស្វ័យប្រវត្តិ (ឧ. https://your-app.onrender.com)
const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;

if (!token) {
  console.error('❌ សូមកំណត់ BOT_TOKEN នៅក្នុង Environment Variables ជាមុនសិន');
  process.exit(1);
}
if (!externalUrl) {
  console.error('❌ រកមិនឃើញ URL សាធារណៈទេ (RENDER_EXTERNAL_URL ឬ WEBHOOK_URL)');
  process.exit(1);
}
if (!mongoUri) {
  console.error('❌ សូមកំណត់ MONGODB_URI នៅក្នុង Environment Variables ជាមុនសិន');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const app = express();
app.use(express.json());

// Admin ដែលមានសិទ្ធិគ្រប់គ្រង Platform (/remove, /list)
const ADMIN_IDS = (process.env.ADMIN_IDS || '1908211979')
  .split(',')
  .map((id) => id.trim());

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// ទម្រង់ platform name ត្រូវការ៖ អក្សរ (មួយ ឬច្រើន) + លេខ ឧ. e98, wc777, ct777, zs777
const PLATFORM_NAME_FORMAT = /^[a-zA-Z]+\d+$/;

// Platform ដែលបានចុះឈ្មោះ (ផ្ទុកក្នុង Memory ជា cache, sync ជាមួយ MongoDB)
let registeredPlatforms = new Set();

// Platform របស់ User ម្នាក់ៗ (userId -> string[] តាមលំដាប់ចុះឈ្មោះ)
let userPlatforms = new Map();

// ផ្ទុកសម័យធ្វើការនីមួយៗ តាម chatId + userId
// { platform, count, active, startedAt }
const sessions = new Map();

// ផ្ទុកសម័យរបាយការណ៍ /sum តាម chatId + userId
// { startDate, platforms: string[], index, currentCount, results: { [platform]: count } }
const sumSessions = new Map();

function getSessionKey(chatId, userId) {
  return `${chatId}_${userId}`;
}

// ថ្ងៃខែឆ្នាំតាមម៉ោងកម្ពុជា ជាទម្រង់ YYYY-MM-DD (ប្រើកាលបរិច្ឆេទចាប់ផ្តើមវេន មិនមែនកាលបរិច្ឆេទវាយ /done ទេ)
function formatShiftDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
}

// ----- /add <platform> → ចុះឈ្មោះ Platform ថ្មី -----
bot.onText(/^\/add(?:@\w+)?\s+(\S+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rawName = match[1].toLowerCase().replace(/^\//, '');

  if (!PLATFORM_NAME_FORMAT.test(rawName)) {
    bot.sendMessage(
      chatId,
      `⚠️ ទម្រង់ Platform មិនត្រឹមត្រូវ។ ត្រូវជា អក្សរ + លេខ ឧទាហរណ៍៖ \`wc777\`, \`ct777\`, \`e98\`\n` +
        `សូមព្យាយាមម្តងទៀត៖ /add wc777`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  try {
    await db.addPlatform(userId, rawName);
    registeredPlatforms.add(rawName);

    const uid = String(userId);
    if (!userPlatforms.has(uid)) {
      userPlatforms.set(uid, []);
    }
    if (!userPlatforms.get(uid).includes(rawName)) {
      userPlatforms.get(uid).push(rawName);
    }

    bot.sendMessage(
      chatId,
      `✅ បានចុះឈ្មោះ Platform *${rawName.toUpperCase()}* សម្រាប់អ្នករួចរាល់!\n` +
        `👉 ប្រើ /${rawName} ដើម្បីចាប់ផ្តើមវេនការងារតែមួយ Platform នេះ\n` +
        `👉 ឬប្រើ /sum ដើម្បីធ្វើរបាយការណ៍សរុបគ្រប់ Platform ដែលអ្នកបានចុះឈ្មោះ`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('❌ Add platform error:', err.message);
    bot.sendMessage(chatId, '❌ មានបញ្ហាក្នុងការរក្សាទុក Platform សូមព្យាយាមម្តងទៀត');
  }
});

// ----- /remove <platform> → លុប Platform ចេញ (Admin ប៉ុណ្ណោះ) -----
bot.onText(/^\/remove(?:@\w+)?\s+(\S+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '⛔ មានតែ Admin ប៉ុណ្ណោះទើបអាចប្រើ /remove បាន');
    return;
  }

  const rawName = match[1].toLowerCase().replace(/^\//, '');

  if (!registeredPlatforms.has(rawName)) {
    bot.sendMessage(chatId, `⚠️ រកមិនឃើញ Platform *${rawName.toUpperCase()}* ក្នុងបញ្ជីទេ`, {
      parse_mode: 'Markdown',
    });
    return;
  }

  try {
    await db.removePlatform(rawName);
    registeredPlatforms.delete(rawName);
    for (const list of userPlatforms.values()) {
      const idx = list.indexOf(rawName);
      if (idx !== -1) list.splice(idx, 1);
    }
    bot.sendMessage(chatId, `🗑️ បានលុប Platform *${rawName.toUpperCase()}* ចេញរួចរាល់ (គ្រប់ User)`, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    console.error('❌ Remove platform error:', err.message);
    bot.sendMessage(chatId, '❌ មានបញ្ហាក្នុងការលុប Platform សូមព្យាយាមម្តងទៀត');
  }
});

// ----- /list → មើលបញ្ជី Platform ទាំងអស់ (Admin ប៉ុណ្ណោះ) -----
bot.onText(/^\/list$/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    bot.sendMessage(chatId, '⛔ មានតែ Admin ប៉ុណ្ណោះទើបអាចប្រើ /list បាន');
    return;
  }

  if (registeredPlatforms.size === 0) {
    bot.sendMessage(chatId, 'បញ្ជី Platform នៅទទេ។ សូមចុះឈ្មោះជាមួយ /add wc777');
    return;
  }
  const list = [...registeredPlatforms].sort().map((p) => `/${p}`).join('\n');
  bot.sendMessage(chatId, `📋 Platform ដែលបានចុះឈ្មោះ៖\n${list}`);
});

// ----- /sum → ចាប់ផ្តើមរបាយការណ៍សរុបវេន (គ្រប់ Platform ដែលបានចុះឈ្មោះ តាមលំដាប់) -----
bot.onText(/^\/sum$/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);

  const platforms = [...(userPlatforms.get(String(userId)) || [])];

  if (platforms.length === 0) {
    bot.sendMessage(
      chatId,
      '⚠️ អ្នកមិនទាន់ចុះឈ្មោះ Platform ណាមួយទេ។ សូម /add platform ជាមុនសិន (ឧ. /add s98)'
    );
    return;
  }

  sumSessions.set(key, {
    startDate: formatShiftDate(new Date()),
    platforms,
    index: 0,
    currentCount: 0,
    results: {},
    finished: false,
  });

  bot.sendMessage(
    chatId,
    `🧾 ចាប់ផ្តើមរបាយការណ៍សរុបវេន (/sum)\n\n` +
      `📩 សូម Forward សារសម្រាប់ Platform *${platforms[0].toUpperCase()}*\n` +
      `⏭️ ចប់ Platform នេះ ហើយចង់ទៅ Platform បន្ទាប់ សូមវាយ /next\n` +
      `🏁 ចប់ Platform ចុងក្រោយ ហើយចង់បានលទ្ធផលសរុប សូមវាយ /done`,
    { parse_mode: 'Markdown' }
  );
});

// ----- /next → ចប់ Platform បច្ចុប្បន្ន ហើយទៅ Platform បន្ទាប់ (ក្នុងវេន /sum) -----
bot.onText(/^\/next$/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);
  const sumSession = sumSessions.get(key);

  if (!sumSession) {
    bot.sendMessage(chatId, '⚠️ អ្នកមិនទាន់ចាប់ផ្តើម /sum ទេ។ សូមវាយ /sum ជាមុនសិន');
    return;
  }

  if (sumSession.finished) {
    bot.sendMessage(
      chatId,
      '⚠️ គ្មាន Platform បន្ទាប់ទៀតទេ (ចប់ Platform ចុងក្រោយរួចហើយ)\n🏁 សូមវាយ /done ដើម្បីទទួលបានលទ្ធផលសរុប'
    );
    return;
  }

  const finishedPlatform = sumSession.platforms[sumSession.index];
  sumSession.results[finishedPlatform] = sumSession.currentCount;
  sumSession.currentCount = 0;

  const isLastPlatform = sumSession.index === sumSession.platforms.length - 1;

  if (isLastPlatform) {
    sumSession.finished = true;
    bot.sendMessage(
      chatId,
      `✅ ចប់ Platform *${finishedPlatform.toUpperCase()}* (${sumSession.results[finishedPlatform]} សារ)\n\n` +
        `⚠️ នេះជា Platform ចុងក្រោយហើយ គ្មាន Platform បន្ទាប់ទៀតទេ\n` +
        `🏁 សូមវាយ /done ដើម្បីទទួលបានលទ្ធផលសរុប`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  sumSession.index += 1;
  const nextPlatform = sumSession.platforms[sumSession.index];
  bot.sendMessage(
    chatId,
    `✅ ចប់ Platform *${finishedPlatform.toUpperCase()}* (${sumSession.results[finishedPlatform]} សារ)\n\n` +
      `📩 សូម Forward សារសម្រាប់ Platform *${nextPlatform.toUpperCase()}*\n` +
      `⏭️ ចប់ Platform នេះ សូមវាយ /next (ឬ /done បើនេះជា Platform ចុងក្រោយ)`,
    { parse_mode: 'Markdown' }
  );
});

// ----- /done → បញ្ចប់វេនការងារ -----
bot.onText(/^\/done$/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);

  // បើកំពុងធ្វើរបាយការណ៍ /sum → គណនាសរុបគ្រប់ Platform ហើយបញ្ចប់
  const sumSession = sumSessions.get(key);
  if (sumSession) {
    // បើមិនទាន់ /next ចប់ Platform បច្ចុប្បន្នទេ (រួមទាំង Platform ចុងក្រោយ) → កត់ត្រាចំនួនបច្ចុប្បន្នផងជាចុងក្រោយ
    if (!sumSession.finished) {
      const currentPlatform = sumSession.platforms[sumSession.index];
      sumSession.results[currentPlatform] = sumSession.currentCount;
    }

    const lines = sumSession.platforms.map(
      (p) => `${p.toUpperCase()}: ${sumSession.results[p] ?? 0}`
    );
    const total = sumSession.platforms.reduce((sum, p) => sum + (sumSession.results[p] ?? 0), 0);

    bot.sendMessage(chatId, `${sumSession.startDate}\n${lines.join('\n')}\nTotal: ${total}`);

    sumSessions.delete(key);
    return;
  }

  // ចាស់៖ វេនការងារ Platform តែមួយ (ចាប់ផ្តើមតាម command platform ដោយផ្ទាល់ ឧ. /s98)
  const session = sessions.get(key);

  if (!session || !session.active) {
    bot.sendMessage(
      chatId,
      '⚠️ អ្នកមិនទាន់ចាប់ផ្តើមវេនការងារទេ។ សូមវាយ platform command ជាមុនសិន (ឧ. /wc777) ឬ /sum។ ' +
        'បើមិនទាន់ចុះឈ្មោះ Platform សូមប្រើ /add wc777'
    );
    return;
  }

  session.active = false;
  bot.sendMessage(
    chatId,
    `🏁 ចប់វេនការងារលើ Platform *${session.platform.toUpperCase()}*\n` +
      `📊 សរុបចំនួនសារ៖ *${session.count}*`,
    { parse_mode: 'Markdown' }
  );

  sessions.delete(key);
});

// ----- /cancel → បោះបង់វេនកំពុងធ្វើបច្ចុប្បន្ន (មិនរាប់ចំនួនសារ) -----
bot.onText(/^\/cancel$/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);

  const sumSession = sumSessions.get(key);
  if (sumSession) {
    sumSessions.delete(key);
    bot.sendMessage(chatId, '🚫 បានបោះបង់របាយការណ៍ /sum ទាំងមូល (មិនរាប់ចំនួនសារទេ)');
    return;
  }

  const session = sessions.get(key);

  if (!session || !session.active) {
    bot.sendMessage(chatId, '⚠️ គ្មានវេនកំពុងធ្វើការទេ ដូច្នេះគ្មានអ្វីត្រូវបោះបង់ទេ។');
    return;
  }

  sessions.delete(key);
  bot.sendMessage(
    chatId,
    `🚫 បានបោះបង់វេនការងារលើ Platform *${session.platform.toUpperCase()}* រួចរាល់ (មិនរាប់ចំនួនសារទេ)`,
    { parse_mode: 'Markdown' }
  );
});

// ----- Generic handler: platform-start commands + message counting -----
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);

  if (!msg.text) {
    // Photo/Video/Sticker គ្មាន text → ធ្លាក់ចូល logic រាប់សារខាងក្រោម
  } else {
    // /add /remove /list /done /cancel /sum /next ត្រូវបានចាប់ដោយ onText រួចហើយ
    if (/^\/(add|remove|list|done|cancel|sum|next)(\s|@|$)/i.test(msg.text)) {
      return;
    }

    // ពិនិត្យថាតើសារនេះជា command ចាប់ផ្តើម platform ដែលបានចុះឈ្មោះឬអត់ (ប្រើតែពេលមិននៅក្នុងវេន /sum)
    const cmdMatch = msg.text.match(/^\/([a-zA-Z]+\d+)(?:@\w+)?$/);
    if (cmdMatch && !sumSessions.has(key)) {
      const platform = cmdMatch[1].toLowerCase();
      const ownPlatforms = userPlatforms.get(String(userId)) || [];

      if (!ownPlatforms.includes(platform)) {
        bot.sendMessage(
          chatId,
          `⚠️ Platform *${platform.toUpperCase()}* មិនទាន់ចុះឈ្មោះសម្រាប់អ្នកទេ។\n` +
            `សូមចុះឈ្មោះជាមុនសិនដោយប្រើ៖ /add ${platform}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      sessions.set(key, {
        platform,
        count: 0,
        active: true,
        startedAt: new Date(),
      });

      bot.sendMessage(
        chatId,
        `✅ ចាប់ផ្តើមវេនការងារលើ Platform *${platform.toUpperCase()}*\n\n` +
          `📩 សូម Forward សារចាប់ពីម៉ោងចាប់ផ្តើមធ្វើការ រហូតដល់ម៉ោងចប់ការងារ\n` +
          `⏹️ នៅពេលចប់ការងារ សូមវាយ /done ដើម្បីមើលចំនួនសារសរុប`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  }

  // ----- បើកំពុងធ្វើរបាយការណ៍ /sum → រាប់សារចូល Platform បច្ចុប្បន្ន -----
  const sumSession = sumSessions.get(key);
  if (sumSession && !sumSession.finished) {
    sumSession.currentCount += 1;
    return;
  }

  // ----- រាប់សារ បើមានវេនការងារ Platform តែមួយកំពុងធ្វើ -----
  const session = sessions.get(key);

  if (session && session.active) {
    session.count += 1;
  }
});

// ----- Webhook endpoint -----
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ----- Health check endpoint (ជួយកុំឲ្យ Render sleep) -----
app.get('/', (req, res) => {
  res.send('🤖 Telegram Shift Bot កំពុងដំណើរការ');
});

// ----- Startup: ភ្ជាប់ MongoDB → ទាញ Platform → បើក Server → កំណត់ Webhook -----
async function start() {
  await db.connect(mongoUri);
  const loaded = await db.loadPlatforms();
  registeredPlatforms = loaded.registeredPlatforms;
  userPlatforms = loaded.userPlatforms;
  console.log(
    `📋 ទាញយក Platform ចំនួន ${registeredPlatforms.size} ពី MongoDB (User ${userPlatforms.size} នាក់)`
  );

  app.listen(port, () => {
    console.log(`🚀 Server កំពុងស្តាប់នៅ port ${port}`);

    const webhookUrl = `${externalUrl}/bot${token}`;
    bot
      .setWebHook(webhookUrl)
      .then(() => console.log(`✅ Webhook បានកំណត់ជោគជ័យ៖ ${webhookUrl}`))
      .catch((err) => console.error('❌ កំណត់ Webhook មិនជោគជ័យ៖', err.message));
  });
}

start().catch((err) => {
  console.error('❌ Server ចាប់ផ្តើមមិនជោគជ័យ៖', err.message);
  process.exit(1);
});
