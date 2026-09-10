export const PENDING_XTREAM_KEY = "pending-xtream-creds";

export type PendingXtreamCreds = {
  server: string;
  username: string;
  password: string;
};

export type AccountEntry = {
  nb: string;
  url: string;
  server: string;
  status: string;
  username: string;
  password: string;
  maxconn: string;
  actconn: string;
  allowedOutputs?: string;
  created?: string;
  expired?: string;
};

function extractNumbering(text: string): string {
  const m = /(?:^|\n)[ \t]*NB[ \t]*:[ \t]*([^\n\r:]+)/i.exec(text);
  return m?.[1]?.trim() ?? "";
}

function extractField(record: string, label: string): string {
  const m = new RegExp(`(?:^|\\n)[^\\n]*?${label}[ \\t]*:[ \\t]*([^\\n\\r]+)`, "i").exec(record);
  const value = m?.[1];
  return value ? value.trim() : "";
}

const MARKER = /^[ \t]*NB[ \t]*:[ \t]*\d+[ \t]*$/i;

export function parseAccountsFile(text: string): AccountEntry[] {
  const records: string[] = [];
  let current: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (const line of lines) {
    if (MARKER.test(line.trim()) && current.length > 0) {
      records.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) records.push(current.join("\n"));

  const trimmed = records.map((r) => r.trim()).filter(Boolean);
  const source = trimmed.length > 0 ? trimmed : [text.trim()];
  if (source.length === 0 || source[0] === "") return [];

  const seen = new Set<string>();
  const entries: AccountEntry[] = [];

  for (const record of source) {
    const urlMatch = /(https?:\/\/[^\s'"<>]+)/i.exec(record);
    const rawUrl = urlMatch?.[1];
    if (!rawUrl) continue;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    const username = extractField(record, "USERNAME") || parsed.searchParams.get("username") || "";
    const password = extractField(record, "PASSWORD") || parsed.searchParams.get("password") || "";
    if (!username || !password) continue;
    const key = `${parsed.origin}|${username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: AccountEntry = {
      nb: extractNumbering(record),
      url: rawUrl,
      server: parsed.origin,
      status: extractField(record, "STATUS") || "Unknown",
      username,
      password,
      maxconn: extractField(record, "MAXCONN"),
      actconn: extractField(record, "ACTCONN"),
    };
    const allowed = extractField(record, "Allowed Outputs");
    const created = extractField(record, "Created on");
    const expired = extractField(record, "Expired on");
    if (allowed) entry.allowedOutputs = allowed;
    if (created) entry.created = created;
    if (expired) entry.expired = expired;
    entries.push(entry);
  }
  return entries;
}
