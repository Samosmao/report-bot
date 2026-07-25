const { MongoClient } = require('mongodb');

let client;
let collection;

/**
 * ភ្ជាប់ទៅ MongoDB និងត្រៀម collection "platforms"
 * ត្រូវហៅ connect() តែម្តងគត់ ពេល server ចាប់ផ្តើម
 */
async function connect(uri) {
  client = new MongoClient(uri);
  await client.connect();

  const dbName = process.env.MONGODB_DB_NAME || 'telegram_shift_bot';
  const db = client.db(dbName);
  collection = db.collection('platforms');

  // ចាស់៖ index តែលើ name (global unique) — ត្រូវលុបចោល ព្រោះឥឡូវ Platform ជាកម្មសិទ្ធិរបស់ User ម្នាក់ៗ
  try {
    await collection.dropIndex('name_1');
    console.log('ℹ️ បានលុប index ចាស់ (name_1)');
  } catch (err) {
    // មិនអីទេបើ index ចាស់មិនមាន
  }

  // ថ្មី៖ unique compound index លើ (userId + name) ដើម្បីអនុញ្ញាតឲ្យ User ផ្សេងគ្នា មាន Platform ឈ្មោះដូចគ្នាបាន
  await collection.createIndex({ userId: 1, name: 1 }, { unique: true });

  console.log('✅ ភ្ជាប់ MongoDB ជោគជ័យ');
}

/**
 * ទាញយក Platform ទាំងអស់ពី MongoDB
 * returns {
 *   registeredPlatforms: Set<string>            // ឈ្មោះ Platform ទាំងអស់ (global, សម្រាប់ admin /list)
 *   userPlatforms: Map<string, string[]>        // userId -> បញ្ជី Platform តាមលំដាប់ដែលបានចុះឈ្មោះ
 * }
 */
async function loadPlatforms() {
  const docs = await collection.find({}).sort({ createdAt: 1 }).toArray();

  const registeredPlatforms = new Set();
  const userPlatforms = new Map();

  for (const doc of docs) {
    registeredPlatforms.add(doc.name);

    const uid = String(doc.userId);
    if (!userPlatforms.has(uid)) {
      userPlatforms.set(uid, []);
    }
    userPlatforms.get(uid).push(doc.name);
  }

  return { registeredPlatforms, userPlatforms };
}

/**
 * បន្ថែម Platform ថ្មីសម្រាប់ User ជាក់លាក់មួយ (មិនកើតកំហុសទេបើមានស្រាប់)
 */
async function addPlatform(userId, name) {
  await collection.updateOne(
    { userId: String(userId), name },
    { $set: { userId: String(userId), name }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}

/**
 * លុប Platform ចេញពី MongoDB (គ្រប់ User ដែលមានឈ្មោះនេះ — សម្រាប់ admin /remove)
 */
async function removePlatform(name) {
  await collection.deleteMany({ name });
}

async function close() {
  if (client) {
    await client.close();
  }
}

module.exports = { connect, loadPlatforms, addPlatform, removePlatform, close };
