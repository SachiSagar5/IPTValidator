/**
 * Heuristic credential detection for the "Auto Detect" source tab.
 *
 * Given free-form text a user pastes in (a Stalker portal + MAC, an Xtream
 * Codes login/link, or an M3U link), figure out which source tab it belongs
 * to and pull out the fields that tab needs.
 */

export type DetectedCredential =
  | { type: "m3u"; urls: string[] }
  | { type: "xtream"; server: string; username: string; password: string }
  | {
      type: "stalker";
      server: string;
      mac: string;
      serial?: string;
      deviceId1?: string;
      deviceId2?: string;
    };

export type DetectResult =
  { ok: true; credential: DetectedCredential } | { ok: false; reason: string };

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const MAC_RE = /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/;

/** Every unique http(s) URL in the text, with trailing punctuation trimmed. */
function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[),.;]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Read a `Label: value` (or `Label=value`) field out of the text.
 *
 * The guard character before the label stops us matching URL query strings
 * such as `?username=…`, and the lookahead stops the capture before the next
 * known label so one-line pastes like `Server: x Username: y` still work.
 */
function extractField(text: string, labels: string): string {
  const stop =
    "(?=[\\r\\n]|\\s+(?:username|user|login|password|pass|pwd|server|portal|host|domain|url|mac|serial|device[ _-]?id)\\b|$)";
  const re = new RegExp(`(?:^|[\\s;,.])(?:${labels})[ \\t]*[:=][ \\t]*([^\\r\\n]*?)${stop}`, "i");
  return re.exec(text)?.[1]?.trim() ?? "";
}

/** Normalise a server/portal value to `http(s)://host[:port]`. */
function normalizeServer(raw: string): string {
  let value = (raw ?? "").trim();
  if (!value) return "";
  const embedded = value.match(/https?:\/\/[^\s"'<>]+/i);
  if (embedded) value = embedded[0];
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

/** Stalker portals expose a few recognisable paths / a `mac` query param. */
function looksLikeStalkerPortal(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return (
      u.searchParams.has("mac") ||
      /\/c\/?$/.test(path) ||
      path.includes("/stalker_portal") ||
      /\/portal\.php$/.test(path) ||
      /\/server\/load\.php$/.test(path)
    );
  } catch {
    return false;
  }
}

/** Pull Xtream credentials out of the common URL shapes. */
function parseXtreamUrl(
  url: string,
): { server: string; username: string; password: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  // .../live/<user>/<pass>/<id>.(ts|m3u8) and the movie/series equivalents.
  const pathCreds = /^\/(?:live|movie|series)\/([^/]+)\/([^/]+)\//i.exec(u.pathname);
  if (pathCreds?.[1] && pathCreds[2]) {
    return {
      server: u.origin,
      username: decodeURIComponent(pathCreds[1]),
      password: decodeURIComponent(pathCreds[2]),
    };
  }

  // .../player_api.php?username=…&password=… (and get.php m3u exports).
  const user = u.searchParams.get("username") ?? u.searchParams.get("user") ?? "";
  const pass = u.searchParams.get("password") ?? u.searchParams.get("pass") ?? "";
  if (user && pass && !/\.(?:m3u8?|ts|mp4)$/i.test(u.pathname)) {
    return { server: u.origin, username: user, password: pass };
  }

  return null;
}

export function detectCredential(rawInput: string): DetectResult {
  const input = rawInput.replace(/\r\n?/g, "\n").trim();
  if (!input) {
    return { ok: false, reason: "Paste a MAC/portal, Xtream login, or M3U link first." };
  }

  const urls = extractUrls(input);
  const mac = (MAC_RE.exec(input)?.[0] ?? "").toUpperCase();
  const labeledUser = extractField(input, "username|user|login");
  const labeledPass = extractField(input, "password|pass|pwd");
  const labeledServer = extractField(input, "server|portal|host|domain|url");
  const serial = extractField(input, "serial(?:[ _-]?number)?");
  const deviceId1 = extractField(input, "device[ _-]?id[ _-]?1");
  const deviceId2 = extractField(input, "device[ _-]?id[ _-]?2");

  // 1) Stalker — a MAC address is the strongest, least ambiguous signal.
  if (mac) {
    const portal = urls.find(looksLikeStalkerPortal) ?? urls[0] ?? labeledServer;
    return {
      ok: true,
      credential: {
        type: "stalker",
        server: normalizeServer(portal),
        mac,
        ...(serial ? { serial } : {}),
        ...(deviceId1 ? { deviceId1 } : {}),
        ...(deviceId2 ? { deviceId2 } : {}),
      },
    };
  }

  // 2) Xtream — either labelled fields or an Xtream-shaped URL.
  const xtreamFromUrl =
    urls.map(parseXtreamUrl).find((x): x is NonNullable<typeof x> => !!x) ?? null;
  if (labeledUser && labeledPass) {
    const server =
      normalizeServer(labeledServer) ||
      xtreamFromUrl?.server ||
      (urls[0] ? normalizeServer(urls[0]) : "");
    if (!server) {
      return {
        ok: false,
        reason:
          "Found a username and password but no server URL. Add the panel address and try again.",
      };
    }
    return {
      ok: true,
      credential: { type: "xtream", server, username: labeledUser, password: labeledPass },
    };
  }
  if (xtreamFromUrl) {
    return { ok: true, credential: { type: "xtream", ...xtreamFromUrl } };
  }

  // 3) M3U — any remaining plain link(s). A lone link that is only the
  // labelled server (e.g. "Server: http://host") is a fragment, not a playlist.
  if (urls.length > 0) {
    const only = urls[0] ?? "";
    if (
      urls.length === 1 &&
      labeledServer &&
      normalizeServer(only) === normalizeServer(labeledServer)
    ) {
      return {
        ok: false,
        reason: "That's just a server address — add a MAC, a login, or a playlist link.",
      };
    }
    return { ok: true, credential: { type: "m3u", urls } };
  }

  return {
    ok: false,
    reason:
      "Couldn't recognise that. Paste a portal + MAC, an Xtream login, or an http(s) M3U link.",
  };
}

// ── Multi-credential detection (paste a file / many lines at once) ─────────

/** A line that labels a field belongs to the record above it, not a new one. */
const FIELD_LINE_RE =
  /^\s*(?:username|user|login|password|pass|pwd|server|portal|host|domain|url|mac|serial(?:[ _-]?number)?|device[ _-]?id[ _-]?[12])\s*[:=]/i;

/**
 * Split free-form text into one string per credential.
 *
 * Blank-line separated blocks win when present (that's how people usually
 * paste a list). Otherwise each line is its own record, except that a
 * `Label: value` line continues the record it belongs to so multi-line
 * blocks like `Username: …\nPassword: …\nServer: …` stay together.
 */
function splitRecords(input: string): string[] {
  const text = input.replace(/\r\n?/g, "\n");

  const blocks = text
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks;

  const records: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const record = current.join("\n").trim();
    if (record) records.push(record);
    current = [];
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (FIELD_LINE_RE.test(line) && current.length > 0) {
      current.push(line);
    } else {
      flush();
      current.push(line);
    }
  }
  flush();
  return records;
}

/** Stable key so the same credential pasted twice only shows up once. */
export function credentialKey(credential: DetectedCredential): string {
  switch (credential.type) {
    case "xtream":
      return `xtream|${credential.server}|${credential.username}|${credential.password}`.toLowerCase();
    case "stalker":
      return `stalker|${credential.server}|${credential.mac}`.toLowerCase();
    case "m3u":
      return `m3u|${credential.urls.join(",")}`.toLowerCase();
  }
}

/**
 * Detect every credential in a larger paste or uploaded text file.
 *
 * Records are detected independently, duplicates are dropped, and all plain
 * playlist links are merged into a single `m3u` credential so the table stays
 * readable. Detection order is preserved, with the merged playlist last.
 */
export function detectCredentials(rawInput: string): DetectedCredential[] {
  const records = splitRecords(rawInput);
  const found: DetectedCredential[] = [];
  const seen = new Set<string>();
  const m3uUrls: string[] = [];
  const m3uSeen = new Set<string>();

  for (const record of records) {
    const result = detectCredential(record);
    if (!result.ok) continue;

    const credential = result.credential;
    if (credential.type === "m3u") {
      for (const url of credential.urls) {
        if (!m3uSeen.has(url)) {
          m3uSeen.add(url);
          m3uUrls.push(url);
        }
      }
      continue;
    }

    const key = credentialKey(credential);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(credential);
  }

  if (m3uUrls.length > 0) {
    found.push({ type: "m3u", urls: m3uUrls });
  }

  return found;
}

/** Human-readable type + detail for a detected credential (for the results table). */
export function describeCredential(credential: DetectedCredential): {
  type: string;
  detail: string;
} {
  switch (credential.type) {
    case "xtream":
      return {
        type: "Xtream Codes",
        detail: `${credential.server} · ${credential.username} / ${credential.password}`,
      };
    case "stalker":
      return {
        type: "Stalker Portal",
        detail: `${credential.server} · ${credential.mac}`,
      };
    case "m3u":
      return {
        type: "M3U Playlist",
        detail:
          credential.urls.length === 1
            ? (credential.urls[0] ?? "")
            : `${credential.urls.length} playlist links`,
      };
  }
}
