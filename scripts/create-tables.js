/**
 * Creates all database tables (schema only, no data).
 * Usage: npm run build && npm run create-tables [dbPath]
 * Default dbPath: ./video-nemesis.db (from project root)
 * If you see ERR_DLOPEN_FAILED / NODE_MODULE_VERSION: run npm rebuild then try again.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] || path.join(__dirname, "..", "video-nemesis.db");

const db = ensureSchema(dbPath);
db.close();
console.log("Tables created at:", dbPath);
