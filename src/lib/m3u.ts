export type Channel = {
  id: string;
  name: string;
  url: string;
  group?: string;
  logo?: string;
  tvgId?: string;
  duration?: string;
  kind?: "live" | "movie" | "series";
  series?: string;
  season?: number;
};

import type { SeriesItem, SeriesSeason, VodItem } from "./panel.functions";

export type SplitChannels = {
  live: Channel[];
  movies: VodItem[];
  series: SeriesItem[];
};

export type ParseIssue = {
  line: number;
  severity: "error" | "warning";
  message: string;
};

export type ParseResult = {
  channels: Channel[];
  issues: ParseIssue[];
  hasHeader: boolean;
};

const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+$/;

function attr(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`${key}="([^"]*)"`, "i"));
  return m?.[1] || undefined;
}

/** Strict-ish M3U/M3U8 parser: reports structural problems instead of silently skipping them. */
export function parseM3U(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const channels: Channel[] = [];
  const issues: ParseIssue[] = [];
  let hasHeader = false;
  let pending: Omit<Channel, "url" | "id"> | null = null;
  let pendingLine = 0;
  let seq = 0;
  const seenUrls = new Set<string>();

  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    const lineNo = i + 1;
    if (!line) return;

    if (line.toUpperCase().startsWith("#EXTM3U")) {
      if (hasHeader)
        issues.push({ line: lineNo, severity: "warning", message: "Duplicate #EXTM3U header" });
      if (channels.length > 0 || pending) {
        issues.push({
          line: lineNo,
          severity: "warning",
          message: "#EXTM3U header is not the first line",
        });
      }
      hasHeader = true;
      return;
    }

    if (line.toUpperCase().startsWith("#EXTINF")) {
      if (pending) {
        issues.push({
          line: pendingLine,
          severity: "error",
          message: `"${pending.name}" has no stream URL after its #EXTINF line`,
        });
      }
      const afterColon = line.slice(line.indexOf(":") + 1);
      const commaIdx = afterColon.lastIndexOf(",");
      if (commaIdx === -1) {
        issues.push({
          line: lineNo,
          severity: "error",
          message: "#EXTINF is missing the comma before the channel name",
        });
        pending = { name: "Unnamed channel" };
        pendingLine = lineNo;
        return;
      }
      const meta = afterColon.slice(0, commaIdx);
      const name = afterColon.slice(commaIdx + 1).trim();
      const duration = meta.trim().split(/\s+/)[0];
      if (!name) issues.push({ line: lineNo, severity: "error", message: "Channel name is empty" });
      if (!duration || !/^-?\d+(\.\d+)?$/.test(duration)) {
        issues.push({
          line: lineNo,
          severity: "warning",
          message: "#EXTINF duration is missing or not a number",
        });
      }
      const group = attr(meta, "group-title");
      const logo = attr(meta, "tvg-logo");
      const tvgId = attr(meta, "tvg-id");
      pending = {
        name: name || "Unnamed channel",
        ...(group ? { group } : {}),
        ...(logo ? { logo } : {}),
        ...(tvgId ? { tvgId } : {}),
        ...(duration ? { duration } : {}),
      };

      pendingLine = lineNo;
      return;
    }

    if (line.startsWith("#")) return; // other directives (#EXTGRP, #EXTVLCOPT, comments)

    if (!URL_RE.test(line)) {
      issues.push({
        line: lineNo,
        severity: "error",
        message: `Not a valid stream URL: "${line.slice(0, 60)}"`,
      });
      pending = null;
      return;
    }

    if (!pending) {
      issues.push({
        line: lineNo,
        severity: "warning",
        message: "Stream URL without a preceding #EXTINF line",
      });
    }
    if (seenUrls.has(line)) {
      issues.push({ line: lineNo, severity: "warning", message: "Duplicate stream URL" });
    }
    seenUrls.add(line);

    channels.push({
      id: `ch-${++seq}`,
      name: pending?.name ?? `Channel ${seq}`,
      url: line,
      ...(pending?.group ? { group: pending.group } : {}),
      ...(pending?.logo ? { logo: pending.logo } : {}),
      ...(pending?.tvgId ? { tvgId: pending.tvgId } : {}),
      ...(pending?.duration ? { duration: pending.duration } : {}),
    });
    pending = null;
  });

  if (pending) {
    issues.push({
      line: pendingLine,
      severity: "error",
      message: "Last #EXTINF line has no stream URL",
    });
  }
  if (!hasHeader) {
    issues.push({
      line: 1,
      severity: "error",
      message: "Missing #EXTM3U header — this is not a valid M3U playlist",
    });
  }
  if (channels.length === 0) {
    issues.push({ line: 1, severity: "error", message: "No channels found" });
  }

  return { channels, issues, hasHeader };
}

/** Extract playlist URLs from a plain .txt file (one per line, ignoring comments). */
export function parseUrlList(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && URL_RE.test(l));
}

export function buildM3U(channels: Channel[]): string {
  const out = ["#EXTM3U"];
  for (const c of channels) {
    const attrs = [
      c.tvgId ? `tvg-id="${c.tvgId}"` : "",
      c.logo ? `tvg-logo="${c.logo}"` : "",
      c.group ? `group-title="${c.group}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    out.push(`#EXTINF:${c.duration ?? "-1"}${attrs ? " " + attrs : ""},${c.name}`);
    out.push(c.url);
  }
  return out.join("\n") + "\n";
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const MOVIE_URL_RE = /\/movie\//i;
const SERIES_URL_RE = /\/series\//i;
const SERIES_EPISODE_RE = /S(\d{1,2})\s*E(\d{1,3})/i;

/** Stable-ish id derived from the last path segment of a stream URL. */
function streamId(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || url;
    return seg.replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return url;
  }
}

function parseSeriesEpisode(
  name: string,
): { base: string; season: number; episode: number } | null {
  const m = name.match(SERIES_EPISODE_RE);
  if (!m) return null;
  const season = Number(m[1]) || 1;
  const episode = Number(m[2]) || 0;
  const base = name
    .replace(SERIES_EPISODE_RE, "")
    .replace(/[\s.|\-_:]*$/g, "")
    .trim();
  return { base, season, episode };
}

/**
 * Splits raw playlist channels into live, VOD movies and series.
 * Xtream-style M3U exports address movies via `/movie/` and each series
 * episode via `/series/`, so those URLs are the reliable signal.
 * Episodes are grouped into seasons and series from their `S##E##` names.
 */
export function classifyChannels(channels: Channel[]): SplitChannels {
  const live: Channel[] = [];
  const movieChans: Channel[] = [];
  const seriesChans: Channel[] = [];

  for (const c of channels) {
    if (SERIES_URL_RE.test(c.url)) seriesChans.push(c);
    else if (MOVIE_URL_RE.test(c.url)) movieChans.push(c);
    else live.push(c);
  }

  const movies: VodItem[] = movieChans.map((c) => ({
    id: streamId(c.url),
    name: c.name,
    url: c.url,
    ...(c.group ? { group: c.group } : {}),
    ...(c.logo ? { logo: c.logo } : {}),
    ...(c.tvgId ? { tvgId: c.tvgId } : {}),
  }));

  const seriesMap = new Map<string, SeriesItem>();
  const seasonMap = new Map<string, Map<number, SeriesSeason>>();

  for (const c of seriesChans) {
    const parsed = parseSeriesEpisode(c.name);
    const base = parsed?.base ?? c.name;
    const seasonNum = parsed?.season ?? 1;
    const key = `${c.group ?? ""}|${base}`;

    let item = seriesMap.get(key);
    if (!item) {
      const seasons: SeriesSeason[] = [];
      const byNum = new Map<number, SeriesSeason>();
      item = {
        id: key,
        name: base,
        ...(c.group ? { group: c.group } : {}),
        ...(c.logo ? { logo: c.logo } : {}),
        seasons,
      };
      seriesMap.set(key, item);
      seasonMap.set(key, byNum);
    } else {
      const byNum = seasonMap.get(key)!;
      const season = byNum.get(seasonNum);
      if (season) {
        season.episodes.push({
          id: streamId(c.url),
          name: c.name,
          url: c.url,
          ...(c.logo ? { logo: c.logo } : {}),
        });
        continue;
      }
    }
    const season: SeriesSeason = {
      season: seasonNum,
      name: `Season ${seasonNum}`,
      episodes: [
        {
          id: streamId(c.url),
          name: c.name,
          url: c.url,
          ...(c.logo ? { logo: c.logo } : {}),
        },
      ],
    };
    item.seasons.push(season);
    seasonMap.get(key)!.set(seasonNum, season);
  }

  for (const item of seriesMap.values()) {
    item.seasons.sort((a, b) => a.season - b.season);
  }

  return { live, movies, series: [...seriesMap.values()] };
}
