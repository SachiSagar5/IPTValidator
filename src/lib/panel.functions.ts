import { createServerFn } from "@tanstack/react-start";
import {
  browserHeaders,
  cloudflareBlockMessage,
  describeHttpFailure,
  firstErrorMessage,
  looksLikeCloudflare,
  playerHeaders,
  responseErrorDetail,
  statusLabel,
  truncate,
} from "./http";

const MAX_BYTES = 12_000_000;

function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https links are supported.");
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error("Private and local network addresses are not allowed.");
  return u;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: URL, timeoutMs = 20_000): Promise<string> {
  const request = (headers: Record<string, string>) =>
    withTimeout(timeoutMs, (signal) =>
      fetch(url.toString(), { signal, redirect: "follow", headers }),
    );

  let res = await request(playerHeaders());
  let text = await res.text();

  // Cloudflare sometimes rejects the VLC player agent but allows a browser
  // agent through — retry once before giving up on a blocked/challenged page.
  if (
    !res.ok &&
    looksLikeCloudflare(text) &&
    !cloudflareBlockMessage(text)?.includes("taken offline")
  ) {
    const retry = await request(browserHeaders("*/*"));
    const retryText = await retry.text();
    if (retry.ok || !looksLikeCloudflare(retryText)) {
      res = retry;
      text = retryText;
    }
  }

  if (!res.ok) throw new Error(describeHttpFailure(res, text));
  return text.slice(0, MAX_BYTES);
}

async function fetchJson<T = unknown>(url: URL, headers?: Record<string, string>): Promise<T> {
  const request = (extra: Record<string, string>) =>
    withTimeout(20_000, (signal) =>
      fetch(url.toString(), {
        signal,
        redirect: "follow",
        headers: { ...playerHeaders("application/json, */*"), ...extra },
      }),
    );

  let res = await request(headers ?? {});
  let text = await res.text();

  if (
    !res.ok &&
    looksLikeCloudflare(text) &&
    !cloudflareBlockMessage(text)?.includes("taken offline")
  ) {
    const retry = await request({ ...browserHeaders(), ...(headers ?? {}) });
    const retryText = await retry.text();
    if (retry.ok || !looksLikeCloudflare(retryText)) {
      res = retry;
      text = retryText;
    }
  }

  if (!res.ok) throw new Error(describeHttpFailure(res, text));
  if (!text.trim()) throw new Error("Server returned an empty body.");
  try {
    return JSON.parse(text) as T;
  } catch {
    const block = cloudflareBlockMessage(text);
    if (block) throw new Error(block);
    throw new Error(`Server returned a non-JSON response — ${responseErrorDetail(text)}`);
  }
}

// ---------------------------------------------------------------------------
// Xtream Codes API
// ---------------------------------------------------------------------------

type XtreamAuthResponse = {
  user_info?: {
    username?: string;
    status?: string;
    exp_date?: string | number;
    auth?: number;
    is_trial?: number;
    active_cons?: number;
    max_connections?: number;
    created_at?: string | number;
  };
  server_info?: { url?: string; port?: string };
};

type XtreamStream = {
  num?: number;
  name?: string;
  stream_type?: string;
  stream_id?: number;
  stream_icon?: string;
  epg_channel_id?: string;
  category_id?: string;
  category_ids?: number[];
};

function buildXtreamM3u(
  server: string,
  username: string,
  password: string,
  streams: XtreamStream[],
  categoryMap: Map<string, string>,
): string {
  const base = server.replace(/\/+$/, "");
  const lines = ["#EXTM3U"];
  for (const s of streams) {
    if (!s.stream_id) continue;
    const streamUrl = `${base}/live/${username}/${password}/${s.stream_id}`;
    const group = s.category_id ? (categoryMap.get(s.category_id) ?? "") : "";
    const logo = s.stream_icon || "";
    const tvgId = s.epg_channel_id || "";
    const name = s.name || `Stream ${s.stream_id}`;
    const attrs = [
      tvgId ? `tvg-id="${tvgId}"` : "",
      logo ? `tvg-logo="${logo}"` : "",
      group ? `group-title="${group}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`#EXTINF:-1${attrs ? " " + attrs : ""},${name}`);
    lines.push(streamUrl);
  }
  return lines.join("\n") + "\n";
}

export const loginXtream = createServerFn({ method: "POST" })
  .validator((data: { server: string; username: string; password: string }) => {
    if (!data.server || !data.username || !data.password) {
      throw new Error("Server, username, and password are required.");
    }
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    const url = new URL(base);
    return {
      server: url.origin,
      username: data.username.trim(),
      password: data.password.trim(),
    };
  })
  .handler(async ({ data }) => {
    const { server, username, password } = data;

    // 1. Authenticate
    const authUrl = new URL(`${server}/player_api.php`);
    authUrl.searchParams.set("username", username);
    authUrl.searchParams.set("password", password);
    const auth = await fetchJson<XtreamAuthResponse>(authUrl);
    if (auth.user_info?.status === "Disabled") {
      throw new Error("Account is disabled.");
    }

    // 2. Fetch categories
    const catUrl = new URL(`${server}/player_api.php`);
    catUrl.searchParams.set("username", username);
    catUrl.searchParams.set("password", password);
    catUrl.searchParams.set("action", "get_live_categories");
    let categories: { category_id?: string; category_name?: string }[] = [];
    try {
      categories = (await fetchJson(catUrl)) as typeof categories;
    } catch {
      // categories are optional
    }
    const categoryMap = new Map<string, string>();
    for (const c of categories) {
      if (c.category_id && c.category_name) categoryMap.set(c.category_id, c.category_name);
    }

    // 3. Fetch live streams
    const streamUrl = new URL(`${server}/player_api.php`);
    streamUrl.searchParams.set("username", username);
    streamUrl.searchParams.set("password", password);
    streamUrl.searchParams.set("action", "get_live_streams");
    const streams = (await fetchJson<XtreamStream[]>(streamUrl)) as XtreamStream[];

    if (!streams.length) {
      throw new Error("No live streams found on this account.");
    }

    // 4. Build M3U and return
    const text = buildXtreamM3u(server, username, password, streams, categoryMap);
    return { text, finalUrl: server, count: streams.length };
  });

export type XtreamAccountCheck = {
  ok: boolean;
  status: string;
  detail: string;
  expDate?: string;
  maxConnections?: number;
  activeConnections?: number;
};

function formatExpiry(exp: string | number | undefined): string | undefined {
  if (exp == null || exp === "") return undefined;
  const numeric =
    typeof exp === "number" ? exp : /^-?\d+(\.\d+)?$/.test(exp.trim()) ? Number(exp.trim()) : NaN;
  if (!Number.isNaN(numeric)) {
    if (numeric <= 0) return undefined;
    const ms = numeric > 1e11 ? numeric : numeric * 1000;
    try {
      return new Date(ms).toLocaleDateString();
    } catch {
      return String(exp);
    }
  }
  return String(exp).trim();
}

export const checkXtreamAccount = createServerFn({ method: "POST" })
  .validator((data: { server: string; username: string; password: string }) => {
    if (!data.server || !data.username || !data.password) {
      throw new Error("Server, username, and password are required.");
    }
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return {
      server: new URL(base).origin,
      username: data.username.trim(),
      password: data.password.trim(),
    };
  })
  .handler(async ({ data }): Promise<XtreamAccountCheck> => {
    const { server, username, password } = data;
    const api = new URL(`${server}/player_api.php`);
    api.searchParams.set("username", username);
    api.searchParams.set("password", password);

    let json: XtreamAuthResponse;
    try {
      json = await fetchJson<XtreamAuthResponse>(api);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "network error";
      return {
        ok: false,
        status: "unreachable",
        detail: `Could not reach the server (${reason}).`,
      };
    }

    const info = json.user_info;
    if (!info) {
      return { ok: false, status: "invalid", detail: "The server did not return user info." };
    }

    const statusRaw = (info.status || "").toString();
    const authOk = info.auth !== undefined ? Number(info.auth) === 1 : true;
    const statusActive =
      /active|enabled|ok\b|paid/i.test(statusRaw) &&
      !/(disabled|expired|banned|not paid|no such|error)/i.test(statusRaw);

    const expDate = formatExpiry(info.exp_date);
    const maxConnections = info.max_connections;
    const activeConnections = info.active_cons;

    const parts: string[] = [];
    if (statusRaw) parts.push(statusRaw);
    if (expDate) parts.push(`expires ${expDate}`);
    if (maxConnections != null) parts.push(`max ${maxConnections} conn`);
    if (activeConnections != null) parts.push(`${activeConnections} active`);

    const ok = authOk && statusActive;
    return {
      ok,
      status: statusRaw || (authOk ? "OK" : "Bad credentials"),
      detail: parts.join(" · ") || (authOk ? "Credentials accepted." : "Invalid credentials."),
      ...(expDate ? { expDate } : {}),
      ...(maxConnections != null ? { maxConnections } : {}),
      ...(activeConnections != null ? { activeConnections } : {}),
    };
  });

// ---------------------------------------------------------------------------
// Stalker Portal API — wire format ported from iptvnator
// ---------------------------------------------------------------------------

type StalkerChannel = {
  id?: number;
  name?: string;
  tv_genre_id?: string;
  cmds?: string[];
  tvg_logo?: string;
  tvg_id?: string;
  number?: number;
  archive?: number;
  cmd?: string;
};

type StalkerCategory = {
  id?: string;
  name?: string;
};

function buildStalkerM3u(channels: StalkerChannel[], categoryMap: Map<string, string>): string {
  const lines = ["#EXTM3U"];
  for (const ch of channels) {
    if (!ch.cmd && (!ch.cmds || ch.cmds.length === 0)) continue;
    const streamUrl = ch.cmd || ch.cmds?.[0] || "";
    if (!streamUrl) continue;
    const group = ch.tv_genre_id ? (categoryMap.get(ch.tv_genre_id) ?? "") : "";
    const logo = ch.tvg_logo || "";
    const tvgId = ch.tvg_id || String(ch.id ?? "");
    const name = ch.name || `Channel ${ch.number ?? ch.id ?? "?"}`;
    const attrs = [
      tvgId ? `tvg-id="${tvgId}"` : "",
      logo ? `tvg-logo="${logo}"` : "",
      group ? `group-title="${group}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`#EXTINF:-1${attrs ? " " + attrs : ""},${name}`);
    lines.push(streamUrl);
  }
  return lines.join("\n") + "\n";
}

export type StalkerIdentityInput = {
  serialNumber?: string;
  deviceId1?: string;
  deviceId2?: string;
};

// ---------------------------------------------------------------------------
// Stalker wire-format helpers (ported from iptvnator)
// ---------------------------------------------------------------------------

const STALKER_MAG_USER_AGENT =
  "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250";

const STALKER_STB_PROFILE_PARAMS: Record<string, string> = {
  ver: "ImageDescription: 0.2.18-r23-250; ImageDate: Wed Oct 21 11:10:12 EEST 2020; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c",
  stb_type: "MAG250",
  hw_version: "1.7-BD-00",
  image_version: "218",
  client_type: "STB",
  num_banks: "2",
  video_out: "hdmi",
  hd: "1",
};

const STALKER_LEGACY_SERIAL = "BEDACD4569BAF";
const STALKER_CFDUID_SUFFIX = "e030245495acd6ebfc1";

function normalizeStalkerSerial(value: string | undefined): string | undefined {
  const serial = (value ?? "").trim();
  if (!serial) return undefined;
  if (serial.toUpperCase() === STALKER_LEGACY_SERIAL) return undefined;
  return serial;
}

type StalkerIdentity = {
  serial: string;
  deviceId1: string;
  deviceId2: string;
};

function normalizeStalkerIdentity(id: StalkerIdentityInput | undefined): StalkerIdentity {
  return {
    serial: normalizeStalkerSerial(id?.serialNumber) ?? "",
    deviceId1: (id?.deviceId1 ?? "").trim(),
    deviceId2: (id?.deviceId2 ?? "").trim(),
  };
}

function clean(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

// Device identity only — the auth token is appended by each caller.
function stalkerIdentityHeaders(id: StalkerIdentityInput | undefined): Record<string, string> {
  const identity = normalizeStalkerIdentity(id);
  const headers: Record<string, string> = {};
  if (identity.serial) headers["SN"] = identity.serial;
  if (identity.deviceId1) headers["Device-Id"] = identity.deviceId1;
  if (identity.deviceId2) headers["Device-Id-2"] = identity.deviceId2;
  return headers;
}

function buildStalkerSerialCfduid(serial: string): string {
  return serial
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "")
    .concat(STALKER_CFDUID_SUFFIX)
    .slice(0, 32)
    .padEnd(32, "0");
}

function buildStalkerCookie(mac: string, serial: string): string {
  const parts = [`mac=${mac}`, "stb_lang=en_US@rg=dezzzz", "timezone=Europe/Berlin"];
  if (serial) parts.push(`__cfduid=${buildStalkerSerialCfduid(serial)}`);
  return parts.join("; ");
}

function buildStalkerHeaders(
  mac: string,
  identity: StalkerIdentity,
  token: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: buildStalkerCookie(mac, identity.serial),
    "User-Agent": STALKER_MAG_USER_AGENT,
    "X-User-Agent": STALKER_MAG_USER_AGENT,
    Accept: "*/*",
    Connection: "keep-alive",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (identity.serial) headers["SN"] = identity.serial;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function stalkerRandom(): string {
  return Math.random().toString(16).slice(2, 10).toUpperCase();
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeStalkerServerUrl(server: string): string {
  let raw = server.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function addStalkerCandidatePaths(candidates: Set<string>, origin: string, dir: string): void {
  const root = dir === "/" ? "" : dir;
  candidates.add(`${origin}${root}/portal.php`);
  candidates.add(`${origin}${root}/server/load.php`);
  if (!root.endsWith("/stalker_portal")) {
    candidates.add(`${origin}${root}/stalker_portal/server/load.php`);
  }
}

function buildStalkerEndpointCandidates(server: string): string[] {
  let raw = server.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
  const base = assertPublicHttpUrl(raw);
  base.search = "";
  base.hash = "";
  const pathname = base.pathname.replace(/\/+$/, "");
  const candidates = new Set<string>();

  if (/\.php$/i.test(pathname)) {
    candidates.add(`${base.origin}${pathname}`);
    const parent = pathname.slice(0, pathname.lastIndexOf("/")) || "/";
    addStalkerCandidatePaths(candidates, base.origin, parent);
  } else {
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.toLowerCase() === "c") segments.pop();
    const dir = segments.length === 0 ? "/" : "/" + segments.join("/");
    addStalkerCandidatePaths(candidates, base.origin, dir);
  }
  return [...candidates];
}

// CMD values arrive pre-encoded from portals; encodeURIComponent would double-encode
// every "://" and "?" in a stream URL, so each byte is escaped individually.
const STALKER_SAFE_CMD_CHAR = /^[A-Za-z0-9\-_.~!*()/:?@$,+=[\]%]$/;

function encodeStalkerCmdValue(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    out += STALKER_SAFE_CMD_CHAR.test(ch)
      ? ch
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function buildStalkerRequestUrl(
  endpoint: string,
  params: Record<string, string | number | undefined>,
): string {
  const url = new URL(endpoint);
  const entries: [string, string][] = [];
  let hasJsWrapper = false;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const str = String(value);
    if (key === "JsHttpRequest") hasJsWrapper = true;
    entries.push([key, key === "cmd" ? encodeStalkerCmdValue(str) : encodeURIComponent(str)]);
  }
  if (!hasJsWrapper) entries.push(["JsHttpRequest", "1-xml"]);
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${v}`).join("&");
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

const STALKER_AUTH_FAILURE_TEXT = [
  /^authorization failed[.!]*(?:\s*\d+)?$/i,
  /^access denied[.!]*$/i,
  /^unauthorized request[.!]*$/i,
];

const STALKER_AUTH_FAILURE_PHRASES = [
  /authorization\s+failed/i,
  /access\s+denied/i,
  /unauthorized\s+request/i,
  /auth\s+failed/i,
  /invalid\s+token/i,
  /\bunauthorized\b/i,
  /authorization/i,
];

function isStalkerAuthFailureBody(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (text.length <= 64) {
    for (const re of STALKER_AUTH_FAILURE_TEXT) if (re.test(text)) return true;
  }
  if (text.length <= 200) {
    for (const re of STALKER_AUTH_FAILURE_PHRASES) if (re.test(text)) return true;
  }
  return false;
}

function stalkerErrorText(status: number, body: string): string {
  const text = body.trim();
  if (!text) return `HTTP ${status}`;
  return truncate(text, 300);
}

type StalkerRequestResult = {
  status: number;
  ok: boolean;
  body: string;
};

async function stalkerRequest(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<StalkerRequestResult> {
  const target = assertPublicHttpUrl(url);
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetch(target, { method: "GET", headers, redirect: "follow", signal });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  });
}

function isStalkerFatalNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

type StalkerProbeKind = "auth-required" | "data" | "not-a-portal";

function classifyStalkerProbe(result: StalkerRequestResult): StalkerProbeKind {
  if (result.status === 401 || result.status === 403) return "auth-required";
  const body = result.body.trim();
  if (!body) return "not-a-portal";
  if (isStalkerAuthFailureBody(body)) return "auth-required";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "not-a-portal";
  }
  if (!parsed || typeof parsed !== "object") return "not-a-portal";
  const js = (parsed as { js?: unknown }).js;
  if (Array.isArray(js)) return "data";
  if (js && typeof js === "object") {
    const obj = js as { data?: unknown; error?: unknown; msg?: unknown };
    if (obj.error || obj.msg) return "not-a-portal";
    if (Array.isArray(obj.data)) return "data";
  }
  return "not-a-portal";
}

const stalkerEndpointCache = new Map<string, string>();

async function resolveStalkerEndpoint(server: string, mac: string): Promise<string> {
  const normalized = normalizeStalkerServerUrl(server);
  assertPublicHttpUrl(normalized);
  const cached = stalkerEndpointCache.get(normalized);
  if (cached) return cached;

  const candidates = buildStalkerEndpointCandidates(server);
  const headers = buildStalkerHeaders(mac, { serial: "", deviceId1: "", deviceId2: "" }, "");
  const probed: string[] = [];

  for (const endpoint of candidates) {
    probed.push(endpoint);
    try {
      const url = buildStalkerRequestUrl(endpoint, { type: "itv", action: "get_genres" });
      const result = await stalkerRequest(url, headers, 12_000);
      const kind = classifyStalkerProbe(result);
      if (kind === "auth-required" || kind === "data") {
        stalkerEndpointCache.set(normalized, endpoint);
        return endpoint;
      }
    } catch (error) {
      if (isStalkerFatalNetworkError(error)) {
        const detail = firstErrorMessage(error);
        throw new Error(`Could not reach ${normalized} — ${detail}`);
      }
    }
  }

  throw new Error(`No Stalker portal answered at ${normalized}. Probed: ${probed.join(", ")}`);
}

type StalkerApiResponse = {
  status: number;
  ok: boolean;
  body: string;
  json?: unknown;
};

type StalkerTokenResponse = StalkerApiResponse & {
  jwt?: string;
  js?: { token?: string };
};

async function stalkerApiGet(
  endpoint: string,
  headers: Record<string, string>,
  params: Record<string, string | number | undefined>,
): Promise<StalkerApiResponse> {
  const url = buildStalkerRequestUrl(endpoint, params);
  const result = await stalkerRequest(url, headers);
  const text = result.body.trim();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return {
    status: result.status,
    ok: result.ok,
    body: result.body,
    ...(json === undefined ? {} : { json }),
  };
}

export const loginStalker = createServerFn({ method: "POST" })
  .validator((data: { server: string; mac: string } & StalkerIdentityInput) => {
    if (!data.server || !data.mac) {
      throw new Error("Server URL and MAC address are required.");
    }
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    const url = new URL(base);
    const mac = data.mac.trim().replace(/-/g, ":").toUpperCase();
    return {
      server: url.origin,
      mac,
      serialNumber: clean(data.serialNumber),
      deviceId1: clean(data.deviceId1),
      deviceId2: clean(data.deviceId2),
    };
  })
  .handler(async ({ data }) => {
    const { server, mac } = data;
    const identity = stalkerIdentityHeaders(data);

    // 1. Get token
    const tokenUrl = new URL(`${server}/stalker_portal/server/api.php`);
    tokenUrl.searchParams.set("type", "stb");
    tokenUrl.searchParams.set("action", "handshake");
    const tokenResp = await fetchJson<StalkerTokenResponse>(tokenUrl, {
      Mac: mac,
      ...identity,
    });
    const token = tokenResp.jwt || tokenResp.js?.token;
    if (!token) {
      const detail = firstErrorMessage(tokenResp);
      throw new Error(
        detail
          ? `Could not authenticate — ${detail}`
          : "Could not authenticate — check server and MAC address.",
      );
    }

    const authHeaders: Record<string, string> = {
      Mac: mac,
      ...identity,
      Authorization: `Bearer ${token}`,
    };

    // 2. Fetch live categories
    const catUrl = new URL(`${server}/stalker_portal/server/api.php`);
    catUrl.searchParams.set("type", "itv");
    catUrl.searchParams.set("action", "get_genres");
    let categories: StalkerCategory[] = [];
    try {
      categories = (await fetchJson<StalkerCategory[]>(catUrl, authHeaders)) as typeof categories;
    } catch {
      // optional
    }
    const categoryMap = new Map<string, string>();
    for (const c of categories) {
      if (c.id && c.name) categoryMap.set(String(c.id), c.name);
    }

    // 3. Fetch channels
    const chUrl = new URL(`${server}/stalker_portal/server/api.php`);
    chUrl.searchParams.set("type", "itv");
    chUrl.searchParams.set("action", "get_ordered_list");
    chUrl.searchParams.set("p", "1");
    chUrl.searchParams.set("c", "5000");
    let channels: StalkerChannel[] = [];
    let channelError: string | null = null;
    try {
      const resp = await fetchJson<{ js?: { data?: StalkerChannel[] } } | StalkerChannel[]>(
        chUrl,
        authHeaders,
      );
      if (Array.isArray(resp)) {
        channels = resp;
      } else if (resp && typeof resp === "object" && "js" in resp && resp.js?.data) {
        channels = resp.js.data;
      }
    } catch (e) {
      channelError = e instanceof Error ? e.message : String(e);
    }

    if (!channels.length) {
      throw new Error(
        channelError
          ? `Channel list failed — ${channelError}`
          : "No channels found — check your MAC address and server.",
      );
    }

    const text = buildStalkerM3u(channels, categoryMap);
    return { text, finalUrl: server, count: channels.length };
  });

// ---------------------------------------------------------------------------
// VOD / Series (Xtream + Stalker)
// ---------------------------------------------------------------------------

export type VodItem = {
  id: string;
  name: string;
  url: string;
  group?: string;
  logo?: string;
  tvgId?: string;
};

export type SeriesEpisode = {
  id: string;
  name: string;
  url: string;
  logo?: string;
};

export type SeriesSeason = {
  season: number;
  name: string;
  episodes: SeriesEpisode[];
};

export type SeriesItem = {
  id: string;
  name: string;
  group?: string;
  logo?: string;
  seasons: SeriesSeason[];
};

function normalizeStalkerCmd(cmd: string | undefined | null, server: string): string {
  if (!cmd) return "";
  const trimmed = cmd.trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    // relative path — resolve below
  }
  return `${server}${trimmed.startsWith("/") ? trimmed : "/" + trimmed}`;
}

function groupName(genreIds: unknown, map: Map<string, string>): string | undefined {
  if (!Array.isArray(genreIds)) return undefined;
  for (const g of genreIds) {
    const n = map.get(String(g));
    if (n) return n;
  }
  return undefined;
}

type StalkerSession = { token: string; headers: Record<string, string> };

async function stalkerAuth(
  server: string,
  mac: string,
  identity: StalkerIdentityInput = {},
): Promise<StalkerSession> {
  const identityHeaders = stalkerIdentityHeaders(identity);
  const handshakeUrl = new URL(`${server}/stalker_portal/server/api.php`);
  handshakeUrl.searchParams.set("type", "stb");
  handshakeUrl.searchParams.set("action", "handshake");
  const tokenResp = await fetchJson<StalkerTokenResponse>(handshakeUrl, {
    Mac: mac,
    ...identityHeaders,
  });
  const token = tokenResp.jwt || tokenResp.js?.token;
  if (!token) {
    const detail = firstErrorMessage(tokenResp);
    throw new Error(
      detail ? `Stalker authentication failed — ${detail}` : "Stalker authentication failed.",
    );
  }
  const headers: Record<string, string> = {
    Mac: mac,
    ...identityHeaders,
    Authorization: `Bearer ${token}`,
  };
  // Some portals require a profile call to finish authorisation.
  try {
    const profileUrl = new URL(`${server}/stalker_portal/server/api.php`);
    profileUrl.searchParams.set("type", "stb");
    profileUrl.searchParams.set("action", "get_profile");
    await fetchJson(profileUrl, headers);
  } catch {
    // optional
  }
  return { token, headers };
}

async function stalkerGenres(
  server: string,
  type: string,
  headers: Record<string, string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const url = new URL(`${server}/stalker_portal/server/api.php`);
    url.searchParams.set("type", type);
    url.searchParams.set("action", "get_genres");
    const resp = await fetchJson<StalkerCategory[]>(url, headers);
    for (const c of resp) if (c.id && c.name) map.set(String(c.id), c.name);
  } catch {
    // optional
  }
  return map;
}

async function stalkerList(
  server: string,
  type: string,
  headers: Record<string, string>,
  pageSize = 100,
  maxPages = 8,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = new URL(`${server}/stalker_portal/server/api.php`);
    url.searchParams.set("type", type);
    url.searchParams.set("action", "get_ordered_list");
    url.searchParams.set("p", String(p));
    url.searchParams.set("c", String(pageSize));
    let page: unknown[] = [];
    try {
      const resp = await fetchJson<{ js?: { data?: unknown[] } } | unknown[]>(url, headers);
      if (Array.isArray(resp)) page = resp;
      else if (resp && typeof resp === "object" && "js" in resp) {
        const js = (resp as { js?: { data?: unknown[] } }).js;
        if (js && Array.isArray(js.data)) page = js.data;
      }
    } catch {
      break;
    }
    if (!page.length) break;
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

export const fetchXtreamVod = createServerFn({ method: "POST" })
  .validator((data: { server: string; username: string; password: string }) => {
    if (!data.server || !data.username || !data.password) {
      throw new Error("Server, username, and password are required.");
    }
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return {
      server: new URL(base).origin,
      username: data.username.trim(),
      password: data.password.trim(),
    };
  })
  .handler(async ({ data }) => {
    const { server, username, password } = data;
    const playerUrl = (action: string) => {
      const u = new URL(`${server}/player_api.php`);
      u.searchParams.set("username", username);
      u.searchParams.set("password", password);
      u.searchParams.set("action", action);
      return u;
    };

    type Cat = { category_id?: string; category_name?: string };
    type VStream = {
      stream_id?: number;
      name?: string;
      stream_icon?: string;
      category_id?: string;
      container_extension?: string;
    };
    type SItem = {
      series_id?: number;
      name?: string;
      series_name?: string;
      cover?: string;
      category_id?: string;
    };

    const movies: VodItem[] = [];
    const series: SeriesItem[] = [];

    // VOD categories + streams
    const catMap = new Map<string, string>();
    try {
      const cats = (await fetchJson<Cat[]>(playerUrl("get_vod_categories"))) as Cat[];
      for (const c of cats)
        if (c.category_id && c.category_name) catMap.set(c.category_id, c.category_name);
    } catch {
      // optional
    }
    try {
      const streams = (await fetchJson<VStream[]>(playerUrl("get_vod_streams"))) as VStream[];
      for (const s of streams) {
        if (!s.stream_id) continue;
        const ext = s.container_extension ? `.${s.container_extension}` : "";
        const group = s.category_id ? catMap.get(s.category_id) : undefined;
        movies.push({
          id: String(s.stream_id),
          name: s.name || `Movie ${s.stream_id}`,
          url: `${server}/movie/${username}/${password}/${s.stream_id}${ext}`,
          ...(group ? { group } : {}),
          ...(s.stream_icon ? { logo: s.stream_icon } : {}),
        });
      }
    } catch {
      // optional
    }

    // Series categories + list
    const scatMap = new Map<string, string>();
    try {
      const cats = (await fetchJson<Cat[]>(playerUrl("get_series_categories"))) as Cat[];
      for (const c of cats)
        if (c.category_id && c.category_name) scatMap.set(c.category_id, c.category_name);
    } catch {
      // optional
    }
    try {
      const list = (await fetchJson<SItem[]>(playerUrl("get_series"))) as SItem[];
      for (const s of list) {
        if (!s.series_id) continue;
        const group = s.category_id ? scatMap.get(s.category_id) : undefined;
        series.push({
          id: String(s.series_id),
          name: s.name || s.series_name || `Series ${s.series_id}`,
          ...(group ? { group } : {}),
          ...(s.cover ? { logo: s.cover } : {}),
          seasons: [],
        });
      }
    } catch {
      // optional
    }

    return { movies, series };
  });

export const fetchXtreamSeriesEpisodes = createServerFn({ method: "POST" })
  .validator((data: { server: string; username: string; password: string; seriesId: string }) => {
    if (!data.server || !data.username || !data.password || !data.seriesId) {
      throw new Error("Server, username, password, and series id are required.");
    }
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return {
      server: new URL(base).origin,
      username: data.username.trim(),
      password: data.password.trim(),
      seriesId: data.seriesId,
    };
  })
  .handler(async ({ data }) => {
    const { server, username, password, seriesId } = data;
    const u = new URL(`${server}/player_api.php`);
    u.searchParams.set("username", username);
    u.searchParams.set("password", password);
    u.searchParams.set("action", "get_series_info");
    u.searchParams.set("series_id", seriesId);
    const info = (await fetchJson(u)) as {
      episodes?: Record<string, { id?: number; title?: string; container_extension?: string }[]>;
    };
    const raw = info.episodes ?? {};
    const seasons: SeriesSeason[] = Object.entries(raw)
      .map(([seasonNum, eps]) => {
        const list = Array.isArray(eps) ? eps : [];
        const episodes: SeriesEpisode[] = list
          .map((e) => {
            if (!e.id) return null;
            return {
              id: String(e.id),
              name: e.title || `Episode ${e.id}`,
              url: `${server}/series/${username}/${password}/${e.id}.${e.container_extension || "mkv"}`,
            };
          })
          .filter((e): e is SeriesEpisode => e !== null);
        return { season: Number(seasonNum) || 1, name: `Season ${seasonNum}`, episodes };
      })
      .filter((s) => s.episodes.length > 0);
    return { seriesId, seasons };
  });

export const fetchStalkerVod = createServerFn({ method: "POST" })
  .validator((data: { server: string; mac: string } & StalkerIdentityInput) => {
    if (!data.server || !data.mac) throw new Error("Server URL and MAC address are required.");
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return {
      server: new URL(base).origin,
      mac: data.mac.trim().replace(/-/g, ":").toUpperCase(),
      serialNumber: clean(data.serialNumber),
      deviceId1: clean(data.deviceId1),
      deviceId2: clean(data.deviceId2),
    };
  })
  .handler(async ({ data }) => {
    const { server, mac } = data;
    const { headers } = await stalkerAuth(server, mac, data);

    const movies: VodItem[] = [];
    const series: SeriesItem[] = [];

    const vodGenres = await stalkerGenres(server, "vod", headers);
    try {
      const items = (await stalkerList(server, "vod", headers)) as {
        id?: number;
        name?: string;
        cmd?: string;
        cmds?: string[];
        genres?: unknown;
        cover?: string;
        cover_big?: string;
        screenshot_uri?: string;
      }[];
      for (const m of items) {
        const url = normalizeStalkerCmd(m.cmd || m.cmds?.[0], server);
        if (!url) continue;
        const group = groupName(m.genres, vodGenres);
        const logo = m.cover || m.cover_big || m.screenshot_uri;
        movies.push({
          id: String(m.id ?? url),
          name: m.name || `Movie ${m.id ?? ""}`.trim(),
          url,
          ...(group ? { group } : {}),
          ...(logo ? { logo } : {}),
        });
      }
    } catch {
      // optional
    }

    const seriesGenres = await stalkerGenres(server, "series", headers);
    try {
      const items = (await stalkerList(server, "series", headers)) as {
        id?: number;
        name?: string;
        cover?: string;
        genres?: unknown;
        series?: {
          id?: number;
          name?: string;
          season?: string | number;
          cmd?: string;
          cmds?: string[];
        }[];
      }[];
      for (const s of items) {
        const eps = Array.isArray(s.series) ? s.series : [];
        const seasonMap = new Map<number, SeriesEpisode[]>();
        for (const e of eps) {
          const url = normalizeStalkerCmd(e.cmd || e.cmds?.[0], server);
          if (!url) continue;
          const season = Number(e.season ?? 1) || 1;
          if (!seasonMap.has(season)) seasonMap.set(season, []);
          seasonMap.get(season)!.push({
            id: String(e.id ?? `${s.id}-${e.name ?? season}-${seasonMap.get(season)!.length}`),
            name: e.name || `Episode ${seasonMap.get(season)!.length + 1}`,
            url,
          });
        }
        if (!eps.length && !s.cover && !s.name) continue;
        const group = groupName(s.genres, seriesGenres);
        series.push({
          id: String(s.id ?? s.name),
          name: s.name || `Series ${s.id ?? ""}`.trim(),
          ...(group ? { group } : {}),
          ...(s.cover ? { logo: s.cover } : {}),
          seasons: [...seasonMap.entries()]
            .map(([season, episodes]) => ({ season, name: `Season ${season}`, episodes }))
            .sort((a, b) => a.season - b.season),
        });
      }
    } catch {
      // optional
    }

    return { movies, series };
  });
