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

type Db = {
  playlists: DbPlaylist[];
  drafts: DbDraft[];
};

const DB_FILE = "db.json";

let dbPath: string | null = null;
let memory: Db | null = null;
let lock: Promise<void> = Promise.resolve();

function getDbPath(): string | null {
  if (dbPath) return dbPath;
  if (typeof process !== "undefined" && process.cwd) {
    dbPath = `${process.cwd()}/${DB_FILE}`;
  }
  return dbPath;
}

function serialized<R>(task: () => Promise<R>): Promise<R> {
  const next = lock.then(task);
  lock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function emptyDb(): Db {
  return { playlists: [], drafts: [] };
}

/** Reads db.json (creating it on first run) and caches the parsed data in memory. */
async function readDb(): Promise<Db> {
  if (memory) return memory;
  const path = getDbPath();
  if (path) {
    try {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Db;
      if (parsed && Array.isArray(parsed.playlists)) {
        memory = {
          playlists: parsed.playlists,
          drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
        };
        return memory;
      }
    } catch {
      // missing or corrupt file — fall through and start fresh
    }
  }
  memory = emptyDb();
  return memory;
}

/** Persists db.json atomically; falls back to in-memory storage when the filesystem is unavailable. */
async function persist(db: Db): Promise<void> {
  memory = db;
  const path = getDbPath();
  if (!path) return;
  try {
    const fs = await import("node:fs/promises");
    const dir = path.slice(0, path.lastIndexOf("/")) || ".";
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.rename(tmp, path);
  } catch {
    // filesystem unavailable (e.g. serverless) — keep data in memory only
  }
}

export async function listAll(): Promise<DbPlaylist[]> {
  return serialized(async () => {
    const db = await readDb();
    return [...db.playlists].sort((a, b) => b.createdAt - a.createdAt);
  });
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
  return serialized(async () => {
    const db = await readDb();
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
    db.playlists = [entry, ...db.playlists];
    await persist(db);
    return entry;
  });
}

export async function removePlaylist(id: string): Promise<void> {
  return serialized(async () => {
    const db = await readDb();
    db.playlists = db.playlists.filter((p) => p.id !== id);
    await persist(db);
  });
}

export async function renameEntry(id: string, name: string): Promise<void> {
  return serialized(async () => {
    const db = await readDb();
    db.playlists = db.playlists.map((p) =>
      p.id === id ? { ...p, name: name.trim() || p.name } : p,
    );
    await persist(db);
  });
}

export async function listDraftEntries(): Promise<DbDraft[]> {
  return serialized(async () => {
    const db = await readDb();
    return [...db.drafts].sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function upsertDraft(entry: {
  id?: string;
  name: string;
  content: string;
}): Promise<DbDraft> {
  return serialized(async () => {
    const db = await readDb();
    const now = Date.now();
    const name = entry.name.trim() || "Untitled draft";
    if (entry.id) {
      const existing = db.drafts.find((d) => d.id === entry.id);
      if (existing) {
        const updated: DbDraft = {
          ...existing,
          name,
          content: entry.content,
          updatedAt: now,
        };
        db.drafts = db.drafts.map((d) => (d.id === entry.id ? updated : d));
        await persist(db);
        return updated;
      }
    }
    const created: DbDraft = {
      id: `dr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      content: entry.content,
      createdAt: now,
      updatedAt: now,
    };
    db.drafts = [created, ...db.drafts];
    await persist(db);
    return created;
  });
}

export async function removeDraft(id: string): Promise<void> {
  return serialized(async () => {
    const db = await readDb();
    db.drafts = db.drafts.filter((d) => d.id !== id);
    await persist(db);
  });
}
