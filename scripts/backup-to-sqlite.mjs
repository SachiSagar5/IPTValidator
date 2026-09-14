import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const src = join(root, "db.json");
const out = join(root, "db-backup.db");

const raw = readFileSync(src, "utf8");
const db = JSON.parse(raw);

const sqlite = new DatabaseSync(out);
try {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      source TEXT,
      provider TEXT,
      server TEXT,
      username TEXT,
      password TEXT,
      mac TEXT,
      channels TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);

  const insertPlaylist = sqlite.prepare(`
    INSERT OR REPLACE INTO playlists
      (id, name, createdAt, source, provider, server, username, password, mac, channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDraft = sqlite.prepare(`
    INSERT OR REPLACE INTO drafts (id, name, content, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `);

  const playlists = Array.isArray(db.playlists) ? db.playlists : [];
  const drafts = Array.isArray(db.drafts) ? db.drafts : [];

  sqlite.exec("BEGIN");
  try {
    for (const p of playlists) {
      insertPlaylist.run(
        p.id,
        p.name ?? "",
        p.createdAt ?? 0,
        p.source ?? null,
        p.provider ?? null,
        p.server ?? null,
        p.username ?? null,
        p.password ?? null,
        p.mac ?? null,
        JSON.stringify(p.channels ?? []),
      );
    }
    for (const d of drafts) {
      insertDraft.run(d.id, d.name ?? "", d.content ?? "", d.createdAt ?? 0, d.updatedAt ?? 0);
    }
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }

  const counts = {
    playlists: playlists.length,
    drafts: drafts.length,
  };
  console.log(`Backed up ${JSON.stringify(counts)} → ${out}`);
  console.log(
    `Verifying… playlists=${sqlite.prepare("SELECT COUNT(*) AS n FROM playlists").get().n}, drafts=${sqlite.prepare("SELECT COUNT(*) AS n FROM drafts").get().n}`,
  );
} finally {
  sqlite.close();
}