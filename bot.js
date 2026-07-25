require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const port = process.env.PORT || 3000;

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

const bot = new TelegramBot(token, { polling: false });
const app = express();
app.use(express.json());

// =====================================================
// ការផ្ទុក Platform ដែលបានចុះឈ្មោះ (persist ជា JSON file)
// ចំណាំ៖ Render filesystem អាច reset នៅពេល deploy ថ្មី
// (ដំណើរការធម្មតារវាងសំណើនានា តែមិន survive redeploy ទេ)
// =====================================================
const DATA_FILE = path.join(__dirname, 'platforms.json');

function loadPlatforms() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return new Set(JSON.parse(raw));
  } catch (err) {
    return new Set();
  }
}

function savePlatforms(platformSet) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify([...platformSet]), 'utf8');
  } catch (err) {
    console.error('❌ Save platforms.json មិនជោគជ័យ៖', err.message);
  }
}

const registeredPlatforms = loadPlatforms();

// ទម្រង់ platform name ត្រូវការ៖ អក្សរ (មួយ ឬច្រើន) + លេខ ឧ. e98, wc777, ct777, zs777
const PLATFORM_NAME_FORMAT = /^[a-zA-Z]+\d+$/;

// ផ្ទុកសម័យធ្វើការនីមួយៗ តាម chatId + userId
// { platform, count, active, startedAt }
const sessions = new Map();

function getSessionKey(chatId, userId) {
  return `${chatId}_${userId}`;
}

// ----- /add <platform> → ចុះឈ្មោះ Platform ថ្មី -----
bot.onText(/^\/add(?:@\w+)?\s+(\S+)$/i, (msg, match) => {
  const chatId = msg.chat.id;
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

  registeredPlatforms.add(rawName);
  savePlatforms(registeredPlatforms);

  bot.sendMessage(
    chatId,
    `✅ បានចុះឈ្មោះ Platform *${rawName.toUpperCase()}* រួចរាល់!\n` +
      `👉 ឥឡូវប្រើ /${rawName} ដើម្បីចាប់ផ្តើមវេនការងារបាន`,
    { parse_mode: 'Markdown' }
  );
});

// ----- /remove <platform> → លុប Platform ចេញ -----
bot.onText(/^\/remove(?:@\w+)?\s+(\S+)$/i, (msg, match) => {
  const chatId = msg.chat.id;
  const rawName = match[1].toLowerCase().replace(/^\//, '');

  if (!registeredPlatforms.has(rawName)) {
    bot.sendMessage(chatId, `⚠️ រកមិនឃើញ Platform *${rawName.toUpperCase()}* ក្នុងបញ្ជីទេ`, {
      parse_mode: 'Markdown',
    });
    return;
  }

  registeredPlatforms.delete(rawName);
  savePlatforms(registeredPlatforms);
  bot.sendMessage(chatId, `🗑️ បានលុប Platform *${rawName.toUpperCase()}* ចេញរួចរាល់`, {
    parse_mode: 'Markdown',
  });
});

// ----- /list → មើលបញ្ជី Platform ទាំងអស់ -----
bot.onText(/^\/list$/, (msg) => {
  const chatId = msg.chat.id;
  if (registeredPlatforms.size === 0) {
    bot.sendMessage(chatId, 'បញ្ជី Platform នៅទទេ។ សូមចុះឈ្មោះជាមួយ /add wc777');
    return;
  }
  const list = [...registeredPlatforms].sort().map((p) => `/${p}`).join('\n');
  bot.sendMessage(chatId, `📋 Platform ដែលបានចុះឈ្មោះ៖\n${list}`);
});

// ----- /done → បញ្ចប់វេនការងារ -----
bot.onText(/^\/done$/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);
  const session = sessions.get(key);

  if (!session || !session.active) {
    bot.sendMessage(
      chatId,
      '⚠️ អ្នកមិនទាន់ចាប់ផ្តើមវេនការងារទេ។ សូមវាយ platform command ជាមុនសិន (ឧ. /wc777)។ ' +
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

// ----- Generic handler: platform-start commands + message counting -----
bot.on('message', (msg) => {
  if (!msg.text) {
    // Photo/Video/Sticker គ្មាន text → ធ្លាក់ចូល logic រាប់សារខាងក្រោម
  } else {
    // /add /remove /list /done ត្រូវបានចាប់ដោយ onText រួចហើយ
    if (/^\/(add|remove|list|done)(\s|@|$)/i.test(msg.text)) {
      return;
    }

    // ពិនិត្យថាតើសារនេះជា command ចាប់ផ្តើម platform ដែលបានចុះឈ្មោះឬអត់
    const cmdMatch = msg.text.match(/^\/([a-zA-Z]+\d+)(?:@\w+)?$/);
    if (cmdMatch) {
      const platform = cmdMatch[1].toLowerCase();
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!registeredPlatforms.has(platform)) {
        bot.sendMessage(
          chatId,
          `⚠️ Platform *${platform.toUpperCase()}* មិនទាន់ចុះឈ្មោះទេ។\n` +
            `សូមចុះឈ្មោះជាមុនសិនដោយប្រើ៖ /add ${platform}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const key = getSessionKey(chatId, userId);
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

  // ----- រាប់សារ បើមានវេនកំពុងធ្វើការ -----
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = getSessionKey(chatId, userId);
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

app.listen(port, () => {
  console.log(`🚀 Server កំពុងស្តាប់នៅ port ${port}`);

  const webhookUrl = `${externalUrl}/bot${token}`;
  bot
    .setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook បានកំណត់ជោគជ័យ៖ ${webhookUrl}`))
    .catch((err) => console.error('❌ កំណត់ Webhook មិនជោគជ័យ៖', err.message));
});
