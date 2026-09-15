import { createClient } from "@libsql/client";

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
};

type DraftRow = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

let client: ReturnType<typeof createClient> | null = null;
let initPromise: Promise<ReturnType<typeof createClient>> | null = null;

/** Lazily creates the LibSQL client, ensures the schema exists and migrates legacy db.json. */
function getClient() {
  if (client) return Promise.resolve(client);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const url = process.env["TURSO_DATABASE_URL"];
    const authToken = process.env["TURSO_AUTH_TOKEN"];

    if (url) {
      client = createClient({
        url,
        ...(authToken ? { authToken } : {}),
      });
    } else {
      console.warn(
        "[db] TURSO_DATABASE_URL not set. Falling back to local file:./db.db — data will NOT persist on serverless hosting.",
      );
      client = createClient({ url: "file:./db.db" });
    }

    await bootstrapSchema();
    await migrateFromJson();
    return client;
  })();

  return initPromise;
}

async function bootstrapSchema(): Promise<void> {
  if (!client) return;
  await client.execute(`
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
      mac TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);
}

/** One-time import of the legacy db.json file once the SQLite tables are empty. */
async function migrateFromJson(): Promise<void> {
  if (!client) return;
  try {
    const count = await client.execute("SELECT COUNT(*) as n FROM playlists");
    const total = Number(count.rows[0]?.["n"] ?? 0);
    if (total > 0) return;
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(`${process.cwd()}/db.json`, "utf8");
    const parsed = JSON.parse(raw) as { playlists?: DbPlaylist[]; drafts?: DbDraft[] };
    for (const p of parsed.playlists ?? []) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO playlists
          (id, name, createdAt, channels, source, provider, server, username, password, mac)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ],
      });
    }
    for (const d of parsed.drafts ?? []) {
      await client.execute({
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
  const db = await getClient();
  const result = await db.execute("SELECT * FROM playlists ORDER BY createdAt DESC");
  return (result.rows as unknown as PlaylistRow[]).map(rowToPlaylist);
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
  };
  await db.execute({
    sql: `INSERT OR REPLACE INTO playlists
      (id, name, createdAt, channels, source, provider, server, username, password, mac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

async function getPlaylistName(db: ReturnType<typeof createClient>, id: string): Promise<string> {
  const result = await db.execute({ sql: "SELECT name FROM playlists WHERE id = ?", args: [id] });
  return (result.rows[0]?.["name"] as string | undefined) ?? "Untitled playlist";
}

export async function listDraftEntries(): Promise<DbDraft[]> {
  const db = await getClient();
  const result = await db.execute("SELECT * FROM drafts ORDER BY updatedAt DESC");
  return (result.rows as unknown as DraftRow[]).map(rowToDraft);
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