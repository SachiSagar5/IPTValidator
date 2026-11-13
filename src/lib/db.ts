import type { Client } from "@libsql/client";

import type { Channel } from "./m3u";

export type DbPlaylist = {
  id: string;
  name: string;
  createdAt: number;
  source?: string;
  channels: Channel[];
  provider?: "xtream" | "stalker";
  server?: string;
  username?: string;
  password?: string;
  mac?: string;
  serialNumber?: string;
  deviceId1?: string;
  deviceId2?: string;
};

export type DbDraft = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

type PlaylistRow = {
  id: string;
  name: string;
  createdAt: number;
  channels: string;
  source: string | null;
  provider: string | null;
  server: string | null;
  username: string | null;
  password: string | null;
  mac: string | null;
  serialNumber: string | null;
  deviceId1: string | null;
  deviceId2: string | null;
};

type DraftRow = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

let client: Client | null = null;
let initPromise: Promise<Client> | null = null;

/**
 * Opens a LibSQL client on the right transport.
 *
 * `@libsql/client` (the default entry) resolves to the native Node binding and
 * pulls in a platform-specific `.node` file. On Vercel that binding is built on
 * the deployment machine's architecture, so a bundle produced on darwin-arm64
 * crashes with ERR_DLOPEN_FAILED when it lands on linux-x64. The `/web` entry is
 * pure fetch + WebSocket with no native dependency, and `expandConfig` inside
 * `@libsql/core` already normalizes `libsql://` to `https://`/`wss://`, so the
 * Turso URL works unchanged. The native entry stays for the local `file:` path,
 * where `/web` cannot help.
 *
 * The native specifier is assembled at runtime rather than written as a literal.
 * Nitro's dependency tracer follows literal dynamic-import specifiers, so a
 * literal `"@libsql/client"` causes the darwin-arm64 `.node` binary to be copied
 * into the linux function bundle — where it can never load. Rollup cannot
 * statically resolve a computed specifier, so the native package stays out of
 * the deployment entirely while still resolving at runtime in local dev.
 */
const NATIVE_ENTRY = ["@libsql", "client"].join("/");

async function openClient(url: string, authToken?: string): Promise<Client> {
  const config = { url, ...(authToken ? { authToken } : {}) };
  if (url.startsWith("file:")) {
    const native = (await import(/* @vite-ignore */ NATIVE_ENTRY)) as typeof import("@libsql/client");
    return native.createClient(config);
  }
  const { createClient } = await import("@libsql/client/web");
  return createClient(config);
}

/** Lazily creates the LibSQL client, ensures the schema exists and migrates legacy db.json. */
function getClient(): Promise<Client> {
  if (client) return Promise.resolve(client);
  if (initPromise) return initPromise;

  const init = async (): Promise<Client> => {
    const url = process.env["TURSO_DATABASE_URL"];
    const authToken = process.env["TURSO_AUTH_TOKEN"];
    const resolved = url ?? "file:./db.db";

    if (!url) {
      console.warn(
        "[db] TURSO_DATABASE_URL not set. Falling back to local file:./db.db — data will NOT persist on serverless hosting.",
      );
    }

    const opened = await openClient(resolved, authToken);
    await bootstrapSchema(opened);
    await migrateFromJson(opened);
    client = opened;
    return opened;
  };

  // A rejected promise would poison the module for the life of the function
  // instance, so a failed init clears itself and the next call retries.
  initPromise = init().catch((error) => {
    initPromise = null;
    client = null;
    console.error("[db] initialisation failed:", error);
    throw error;
  });

  return initPromise;
}

async function bootstrapSchema(db: Client): Promise<void> {
  try {
    await db.execute(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      channels TEXT NOT NULL,
      source TEXT,
      provider TEXT,
      server TEXT,
      username TEXT,
      password TEXT,
      mac TEXT,
      serialNumber TEXT,
      deviceId1 TEXT,
      deviceId2 TEXT
    )
  `);
    await db.execute(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);
  } catch (error) {
    // Schema creation is fatal for writes but not for reads — callers degrade to
    // an empty list rather than taking the whole SSR render down with them.
    console.error("[db] schema bootstrap failed:", error);
    throw error;
  }

  // Databases created before the stalker identity fields exist lack these columns.
  for (const column of ["serialNumber", "deviceId1", "deviceId2"]) {
    try {
      await db.execute(`ALTER TABLE playlists ADD COLUMN ${column} TEXT`);
    } catch {
      // column already exists — nothing to do
    }
  }
}

/** One-time import of the legacy db.json file once the SQLite tables are empty. */
async function migrateFromJson(db: Client): Promise<void> {
  // Legacy import is a local-dev convenience only. Skipping it on Vercel keeps
  // node:fs out of the serverless path entirely.
  if (process.env["VERCEL"] && process.env["IMPORT_DB_JSON"] !== "1") return;
  try {
    const count = await db.execute("SELECT COUNT(*) as n FROM playlists");
    const total = Number(count.rows[0]?.["n"] ?? 0);
    if (total > 0) return;
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(`${process.cwd()}/db.json`, "utf8");
    const parsed = JSON.parse(raw) as { playlists?: DbPlaylist[]; drafts?: DbDraft[] };
    for (const p of parsed.playlists ?? []) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO playlists
          (id, name, createdAt, channels, source, provider, server, username, password, mac, serialNumber, deviceId1, deviceId2)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          p.id,
          p.name,
          p.createdAt,
          JSON.stringify(p.channels ?? []),
          p.source ?? null,
          p.provider ?? null,
          p.server ?? null,
          p.username ?? null,
          p.password ?? null,
          p.mac ?? null,
          p.serialNumber ?? null,
          p.deviceId1 ?? null,
          p.deviceId2 ?? null,
        ],
      });
    }
    for (const d of parsed.drafts ?? []) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO drafts (id, name, content, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?)`,
        args: [d.id, d.name, d.content, d.createdAt, d.updatedAt],
      });
    }
    console.log(
      `[db] Migrated ${parsed.playlists?.length ?? 0} playlists and ${parsed.drafts?.length ?? 0} drafts from db.json.`,
    );
  } catch {
    // no db.json or migration already done — ignore
  }
}

function rowToPlaylist(row: PlaylistRow): DbPlaylist {
  const playlist: DbPlaylist = {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    channels: (() => {
      try {
        return JSON.parse(row.channels) as Channel[];
      } catch {
        return [];
      }
    })(),
  };
  if (row.source) playlist.source = row.source;
  if (row.provider === "xtream" || row.provider === "stalker") playlist.provider = row.provider;
  if (row.server) playlist.server = row.server;
  if (row.username) playlist.username = row.username;
  if (row.password) playlist.password = row.password;
  if (row.mac) playlist.mac = row.mac;
  if (row.serialNumber) playlist.serialNumber = row.serialNumber;
  if (row.deviceId1) playlist.deviceId1 = row.deviceId1;
  if (row.deviceId2) playlist.deviceId2 = row.deviceId2;
  return playlist;
}

function rowToDraft(row: DraftRow): DbDraft {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAll(): Promise<DbPlaylist[]> {
  try {
    const db = await getClient();
    const result = await db.execute("SELECT * FROM playlists ORDER BY createdAt DESC");
    return (result.rows as unknown as PlaylistRow[]).map(rowToPlaylist);
  } catch (error) {
    // A dead DB must not blank the whole UI — the page paints empty and the
    // user sees a retryable state instead of the SSR error wall.
    console.error("[db] listAll failed:", error);
    return [];
  }
}

export async function createPlaylist(
  name: string,
  channels: Channel[],
  source?: string,
  provider?: {
    provider?: "xtream" | "stalker";
    server?: string;
    username?: string;
    password?: string;
    mac?: string;
    serialNumber?: string;
    deviceId1?: string;
    deviceId2?: string;
  },
): Promise<DbPlaylist> {
  const db = await getClient();
  const entry: DbPlaylist = {
    id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Untitled playlist",
    createdAt: Date.now(),
    channels,
    ...(source ? { source } : {}),
    ...(provider?.provider ? { provider: provider.provider } : {}),
    ...(provider?.server ? { server: provider.server } : {}),
    ...(provider?.username ? { username: provider.username } : {}),
    ...(provider?.password ? { password: provider.password } : {}),
    ...(provider?.mac ? { mac: provider.mac } : {}),
    ...(provider?.serialNumber ? { serialNumber: provider.serialNumber } : {}),
    ...(provider?.deviceId1 ? { deviceId1: provider.deviceId1 } : {}),
    ...(provider?.deviceId2 ? { deviceId2: provider.deviceId2 } : {}),
  };
  await db.execute({
    sql: `INSERT OR REPLACE INTO playlists
      (id, name, createdAt, channels, source, provider, server, username, password, mac, serialNumber, deviceId1, deviceId2)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.id,
      entry.name,
      entry.createdAt,
      JSON.stringify(entry.channels),
      entry.source ?? null,
      entry.provider ?? null,
      entry.server ?? null,
      entry.username ?? null,
      entry.password ?? null,
      entry.mac ?? null,
      entry.serialNumber ?? null,
      entry.deviceId1 ?? null,
      entry.deviceId2 ?? null,
    ],
  });
  return entry;
}

export async function removePlaylist(id: string): Promise<void> {
  const db = await getClient();
  await db.execute({ sql: "DELETE FROM playlists WHERE id = ?", args: [id] });
}

export async function renameEntry(id: string, name: string): Promise<void> {
  const db = await getClient();
  await db.execute({
    sql: "UPDATE playlists SET name = ? WHERE id = ?",
    args: [name.trim() || (await getPlaylistName(db, id)), id],
  });
}

async function getPlaylistName(db: Client, id: string): Promise<string> {
  const result = await db.execute({ sql: "SELECT name FROM playlists WHERE id = ?", args: [id] });
  return (result.rows[0]?.["name"] as string | undefined) ?? "Untitled playlist";
}

export async function listDraftEntries(): Promise<DbDraft[]> {
  try {
    const db = await getClient();
    const result = await db.execute("SELECT * FROM drafts ORDER BY updatedAt DESC");
    return (result.rows as unknown as DraftRow[]).map(rowToDraft);
  } catch (error) {
    console.error("[db] listDraftEntries failed:", error);
    return [];
  }
}

export async function upsertDraft(entry: {
  id?: string;
  name: string;
  content: string;
}): Promise<DbDraft> {
  const db = await getClient();
  const now = Date.now();
  const name = entry.name.trim() || "Untitled draft";
  if (entry.id) {
    const existing = await db.execute({
      sql: "SELECT * FROM drafts WHERE id = ?",
      args: [entry.id],
    });
    if (existing.rows.length > 0) {
      const createdAt = Number((existing.rows[0] as unknown as DraftRow).createdAt) || now;
      await db.execute({
        sql: "UPDATE drafts SET name = ?, content = ?, updatedAt = ? WHERE id = ?",
        args: [name, entry.content, now, entry.id],
      });
      return { id: entry.id, name, content: entry.content, createdAt, updatedAt: now };
    }
  }
  const created: DbDraft = {
    id: `dr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    content: entry.content,
    createdAt: now,
    updatedAt: now,
  };
  await db.execute({
    sql: "INSERT INTO drafts (id, name, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    args: [created.id, created.name, created.content, created.createdAt, created.updatedAt],
  });
  return created;
}

export async function removeDraft(id: string): Promise<void> {
  const db = await getClient();
  await db.execute({ sql: "DELETE FROM drafts WHERE id = ?", args: [id] });
}