import { createServerFn } from "@tanstack/react-start";

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
  const res = await withTimeout(timeoutMs, (signal) =>
    fetch(url.toString(), {
      signal,
      redirect: "follow",
      headers: { "user-agent": "VLC/3.0.20 LibVLC/3.0.20", accept: "*/*" },
    }),
  );
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  const text = (await res.text()).slice(0, MAX_BYTES);
  return text;
}

async function fetchJson<T = unknown>(url: URL, headers?: Record<string, string>): Promise<T> {
  const res = await withTimeout(20_000, (signal) =>
    fetch(url.toString(), {
      signal,
      redirect: "follow",
      headers: {
        "user-agent": "VLC/3.0.20 LibVLC/3.0.20",
        accept: "application/json, */*",
        ...headers,
      },
    }),
  );
  if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
  return (await res.json()) as T;
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
// Stalker Portal / Ministra API
// ---------------------------------------------------------------------------

type StalkerTokenResponse = {
  jwt?: string;
  js?: { token?: string; expires?: number };
};

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

export const loginStalker = createServerFn({ method: "POST" })
  .validator((data: { server: string; mac: string }) => {
    if (!data.server || !data.mac) {
      throw new Error("Server URL and MAC address are required.");
    }
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    const url = new URL(base);
    const mac = data.mac.trim().replace(/-/g, ":").toUpperCase();
    return { server: url.origin, mac };
  })
  .handler(async ({ data }) => {
    const { server, mac } = data;

    // 1. Get token
    const tokenUrl = new URL(`${server}/stalker_portal/server/api.php`);
    tokenUrl.searchParams.set("type", "stb");
    tokenUrl.searchParams.set("action", "handshake");
    const tokenResp = await fetchJson<StalkerTokenResponse>(tokenUrl, {
      Mac: mac,
    });
    const token = tokenResp.jwt || tokenResp.js?.token;
    if (!token) throw new Error("Could not authenticate — check server and MAC address.");

    const authHeaders: Record<string, string> = {
      Mac: mac,
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
    } catch {
      // empty
    }

    if (!channels.length) {
      throw new Error("No channels found — check your MAC address and server.");
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

async function stalkerAuth(server: string, mac: string): Promise<StalkerSession> {
  const handshakeUrl = new URL(`${server}/stalker_portal/server/api.php`);
  handshakeUrl.searchParams.set("type", "stb");
  handshakeUrl.searchParams.set("action", "handshake");
  const tokenResp = await fetchJson<StalkerTokenResponse>(handshakeUrl, { Mac: mac });
  const token = tokenResp.jwt || tokenResp.js?.token;
  if (!token) throw new Error("Stalker authentication failed.");
  const headers: Record<string, string> = {
    Mac: mac,
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
  .validator((data: { server: string; mac: string }) => {
    if (!data.server || !data.mac) throw new Error("Server URL and MAC address are required.");
    let base = data.server.trim();
    if (!/^https?:\/\//i.test(base)) base = "http://" + base;
    return { server: new URL(base).origin, mac: data.mac.trim().replace(/-/g, ":").toUpperCase() };
  })
  .handler(async ({ data }) => {
    const { server, mac } = data;
    const { headers } = await stalkerAuth(server, mac);

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
