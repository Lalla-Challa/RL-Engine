import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";
import {
  users,
  InsertUser,
  userSettings,
  InsertUserSetting,
  userStorage,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { LOCAL_USER_OPEN_ID } from "@shared/const";

// Use createRequire for CJS packages that don't export ESM-compatible defaults.
// (Non-literal specifier so bundlers leave this as a runtime require.)
const nodeRequire = createRequire(import.meta.url);
const sqlCipherPkg = "better-sqlite3-multiple-ciphers";
const Database = nodeRequire(sqlCipherPkg) as typeof BetterSqlite3;

// ─── Connection management (SQLCipher-encrypted) ────────────────────────────

let _sqlite: BetterSqlite3.Database | null = null;
let _db: BetterSQLite3Database<Record<string, unknown>> | null = null;

export function openLocalDb(keyHex: string): void {
  closeLocalDb();
  const sqlite = new Database(ENV.dbPath);
  sqlite.pragma(`key = "x'${keyHex}'"`);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  // Sanity check — throws on wrong key
  sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
  _sqlite = sqlite;
  _db = drizzle(sqlite);
}

export function closeLocalDb(): void {
  try {
    _sqlite?.close();
  } catch {
    // ignore close errors
  }
  _sqlite = null;
  _db = null;
}

export function runMigrations(): void {
  if (!_db) throw new Error("Database not open");
  migrate(_db, { migrationsFolder: ENV.migrationsDir });
}

export function rekeyLocalDb(newKeyHex: string): void {
  if (!_sqlite) throw new Error("Database not open");
  _sqlite.pragma(`rekey = "x'${newKeyHex}'"`);
}

export function getDb(): BetterSQLite3Database<Record<string, unknown>> | null {
  return _db;
}

export function getRawDb(): BetterSqlite3.Database | null {
  return _sqlite;
}

export function ensureLocalUser(): void {
  const db = getDb();
  if (!db) throw new Error("Database not open");
  const existing = db.select().from(users).where(eq(users.openId, LOCAL_USER_OPEN_ID)).get();
  if (!existing) {
    const now = new Date();
    db.insert(users)
      .values({
        openId: LOCAL_USER_OPEN_ID,
        name: "Local Author",
        email: null,
        loginMethod: "local",
        role: "super_admin",
        createdAt: now,
        updatedAt: now,
        lastSignedIn: now,
      })
      .run();
    const user = db.select().from(users).where(eq(users.openId, LOCAL_USER_OPEN_ID)).get()!;
    db.insert(userStorage)
      .values({ userId: user.id, usedBytes: 0 })
      .run();
  }
}

export function getLocalUser(): typeof users.$inferSelect | null {
  const db = getDb();
  if (!db) return null;
  return db.select().from(users).where(eq(users.openId, LOCAL_USER_OPEN_ID)).get() ?? null;
}

// ─── User queries ───────────────────────────────────────────────────────────

export function upsertUser(user: InsertUser): void {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = getDb();
  if (!db) { console.warn("[Database] Database not open"); return; }

  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod", "passwordHash"] as const;
  type TextField = (typeof textFields)[number];
  const assign = (field: TextField) => {
    if (user[field] === undefined) return;
    updateSet[field] = user[field] ?? null;
  };
  textFields.forEach(assign);

  if (user.lastSignedIn !== undefined) updateSet.lastSignedIn = user.lastSignedIn;
  if (user.role !== undefined) updateSet.role = user.role;
  if (user.contactEmail !== undefined) updateSet.contactEmail = user.contactEmail;

  // Ensure lastSignedIn is always set
  if (!updateSet.lastSignedIn) updateSet.lastSignedIn = new Date();

  db.insert(users)
    .values({
      openId: user.openId,
      ...(user.name !== undefined ? { name: user.name } : {}),
      ...(user.email !== undefined ? { email: user.email } : {}),
      ...(user.loginMethod !== undefined ? { loginMethod: user.loginMethod } : {}),
      ...(user.passwordHash !== undefined ? { passwordHash: user.passwordHash } : {}),
      ...(user.lastSignedIn !== undefined ? { lastSignedIn: user.lastSignedIn } : {}),
      ...(user.role !== undefined ? { role: user.role } : {}),
      ...(user.contactEmail !== undefined ? { contactEmail: user.contactEmail } : {}),
    })
    .onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    })
    .run();
}

export function getUserById(id: number) {
  const db = getDb();
  if (!db) return undefined;
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function getUserByOpenId(openId: string) {
  const db = getDb();
  if (!db) return undefined;
  return db.select().from(users).where(eq(users.openId, openId)).get();
}

export function getUserByEmail(email: string) {
  const db = getDb();
  if (!db) return undefined;
  return db.select().from(users).where(eq(users.email, email)).get();
}

// ─── User Settings / Storage queries ────────────────────────────────────────

export function getUserSettings(userId: number) {
  const db = getDb();
  if (!db) return undefined;
  return db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
}

export function upsertUserSettings(userId: number, data: Partial<InsertUserSetting>) {
  const db = getDb();
  if (!db) throw new Error("Database not available");

  const existing = getUserSettings(userId);
  if (existing) {
    db.update(userSettings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId))
      .run();
  } else {
    db.insert(userSettings).values({ userId, ...data } as InsertUserSetting).run();
  }
  return getUserSettings(userId);
}

export function getStorageUsage(userId: number) {
  const db = getDb();
  if (!db) return undefined;
  const result = db.select().from(userStorage).where(eq(userStorage.userId, userId)).get();
  if (!result) {
    db.insert(userStorage).values({ userId, usedBytes: 0 }).run();
    return db.select().from(userStorage).where(eq(userStorage.userId, userId)).get();
  }
  return result;
}

// ─── Module data layers (facade re-exports) ─────────────────────────────────
// The CRUD for each domain lives in server/modules/<domain>/*.data.ts. This
// file re-exports them so existing `import * as db from "../db"` call sites
// keep working while the implementation stays modular.

export * from "./modules/projects/project.data";
export * from "./modules/scenes/scenes.data";
export * from "./modules/actors/actor.data";
export * from "./modules/world/world.data";
export * from "./modules/simulation/simulation.data";