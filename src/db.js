import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "pool_callers";

let client;
let database;
let connecting;

export function mongoUri() {
  return uri.replace(/\/\/[^@/]+@/, "//");
}

export async function getDb() {
  if (database) return database;
  if (!connecting) {
    connecting = (async () => {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
      await client.connect();
      database = client.db(dbName);
      await database.collection("pools").createIndex({ factoryId: 1, creationBlock: 1 });
      await database.collection("scans").createIndex({ factoryId: 1, updatedAt: -1 });
      await database.collection("factories").createIndex({ updatedAt: -1 });
      return database;
    })();
  }
  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

export async function mongoStatus() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return { ok: true, uri: mongoUri(), db: dbName };
  } catch (err) {
    return { ok: false, uri: mongoUri(), db: dbName, error: err.message };
  }
}
