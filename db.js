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

  // index លើ name ដើម្បីកុំឲ្យស្ទួន
  await collection.createIndex({ name: 1 }, { unique: true });

  console.log('✅ ភ្ជាប់ MongoDB ជោគជ័យ');
}

/**
 * ទាញយក Platform ទាំងអស់ពី MongoDB ជា Set
 */
async function loadPlatforms() {
  const docs = await collection.find({}).toArray();
  return new Set(docs.map((doc) => doc.name));
}

/**
 * បន្ថែម Platform ថ្មីចូល MongoDB (មិនកើតកំហុសទេបើមានស្រាប់)
 */
async function addPlatform(name) {
  await collection.updateOne({ name }, { $set: { name } }, { upsert: true });
}

/**
 * លុប Platform ចេញពី MongoDB
 */
async function removePlatform(name) {
  await collection.deleteOne({ name });
}

async function close() {
  if (client) {
    await client.close();
  }
}

module.exports = { connect, loadPlatforms, addPlatform, removePlatform, close };
