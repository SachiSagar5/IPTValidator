import { createServerFn } from "@tanstack/react-start";

const MAX_BYTES = 12_000_000;
const MAX_BATCH = 120;

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

/** Download a remote playlist so the browser is not blocked by cross-origin rules. */
export const fetchPlaylist = createServerFn({ method: "POST" })
  .inputValidator((data: { url: string }) => {
    if (!data || typeof data.url !== "string") throw new Error("A playlist URL is required.");
    return { url: data.url.trim() };
  })
  .handler(async ({ data }) => {
    const url = assertPublicHttpUrl(data.url);
    const res = await withTimeout(20_000, (signal) =>
      fetch(url.toString(), {
        signal,
        redirect: "follow",
        headers: { "user-agent": "VLC/3.0.20 LibVLC/3.0.20", accept: "*/*" },
      }),
    ).catch((e: unknown) => {
      throw new Error(
        `Could not reach that link (${e instanceof Error ? e.message : "network error"}).`,
      );
    });

    if (!res.ok) throw new Error(`The link responded with status ${res.status}.`);

    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > MAX_BYTES) throw new Error("That playlist is too large (over 12 MB).");

    const text = (await res.text()).slice(0, MAX_BYTES);
    return {
      text,
      finalUrl: res.url || url.toString(),
      contentType: res.headers.get("content-type") ?? "",
      bytes: text.length,
    };
  });

export type ChannelCheck = {
  url: string;
  status: "ok" | "dead" | "timeout" | "blocked" | "expired";
  httpStatus?: number;
  contentType?: string;
  ms: number;
  detail?: string;
};

const STREAM_HINTS = [
  "mpegurl",
  "video/",
  "audio/",
  "octet-stream",
  "mp2t",
  "dash+xml",
  "application/binary",
];

const MEDIA_SEGMENT_HINTS = [
  "mpegurl",
  "video/",
  "audio/",
  "octet-stream",
  "mp2t",
  "application/binary",
  "application/vnd.apple.mpegurl",
];

const MAX_PLAYLIST_BYTES = 256_000;

/**
 * A stream is reported by the server but is actually dead. Many providers park
 * expired streams behind an HTTP 200 with a playlist that has no segments, or a
 * playlist whose segments 404/403. Return the expiry reason when we can prove it.
 */
async function verifyHlsManifest(
  manifestUrl: string,
  initialText: string,
): Promise<{ expired: boolean; detail?: string }> {
  let text = initialText;

  // The initial read was capped at ~2 KB — if it looks truncated, re-fetch the whole playlist.
  if (initialText.length >= 2000) {
    try {
      const res = await withTimeout(6_000, (signal) =>
        fetch(manifestUrl, {
          signal,
          redirect: "follow",
          headers: { "user-agent": "VLC/3.0.20 LibVLC/3.0.20", accept: "*/*" },
        }),
      );
      if (res.ok) text = (await res.text()).slice(0, MAX_PLAYLIST_BYTES);
    } catch {
      // keep the partial text we already have
    }
  }

  // Media segments are every non-directive line in the playlist.
  const segments = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (segments.length === 0) {
    return { expired: true, detail: "Playlist has no playable segments (expired stream)" };
  }

  // Verify the first segment actually serves media — expired streams 404 it.
  try {
    const segmentUrl = new URL(segments[0]!, manifestUrl).toString();
    const seg = await withTimeout(6_000, (signal) =>
      fetch(segmentUrl, {
        signal,
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": "VLC/3.0.20 LibVLC/3.0.20",
          accept: "*/*",
          range: "bytes=0-1023",
        },
      }),
    );
    if (!seg.ok && seg.status !== 206) {
      return {
        expired: true,
        detail: `First segment returned HTTP ${seg.status} (expired stream)`,
      };
    }
    const segContentType = (seg.headers.get("content-type") ?? "").toLowerCase();
    const looksLikeMedia =
      segContentType === "" || MEDIA_SEGMENT_HINTS.some((h) => segContentType.includes(h));
    if (!looksLikeMedia) {
      return { expired: true, detail: "Segment did not return a media payload (expired stream)" };
    }
  } catch {
    // Timeout / network error for the segment is ambiguous — don't mark expired on that alone.
  }

  return { expired: false };
}

async function checkOne(rawUrl: string, mode: "quick" | "deep"): Promise<ChannelCheck> {
  const started = Date.now();
  let url: URL;
  try {
    url = assertPublicHttpUrl(rawUrl);
  } catch (e) {
    return {
      url: rawUrl,
      status: "blocked",
      ms: 0,
      detail: e instanceof Error ? e.message : "blocked",
    };
  }

  const timeout = mode === "deep" ? 12_000 : 6_000;
  try {
    const res = await withTimeout(timeout, (signal) =>
      fetch(url.toString(), {
        signal,
        method: mode === "deep" ? "GET" : "HEAD",
        redirect: "follow",
        headers: {
          "user-agent": "VLC/3.0.20 LibVLC/3.0.20",
          accept: "*/*",
          ...(mode === "deep" ? { range: "bytes=0-2047" } : {}),
        },
      }),
    );

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const ms = Date.now() - started;

    // Some servers reject HEAD — retry once with a ranged GET before calling it dead.
    if (mode === "quick" && (res.status === 405 || res.status === 501 || res.status === 400)) {
      return await checkOne(rawUrl, "deep");
    }

    if (!res.ok && res.status !== 206) {
      return { url: rawUrl, status: "dead", httpStatus: res.status, contentType, ms };
    }

    if (mode === "deep") {
      const buf = new Uint8Array(await res.arrayBuffer());
      const head = new TextDecoder().decode(buf.slice(0, 256));
      const looksLikeHls = head.includes("#EXTM3U");
      const looksLikeStream = STREAM_HINTS.some((h) => contentType.includes(h)) || looksLikeHls;
      const looksLikeHtml = contentType.includes("text/html") || /<html/i.test(head);
      if (looksLikeHtml && !looksLikeHls) {
        return {
          url: rawUrl,
          status: "dead",
          httpStatus: res.status,
          contentType,
          ms,
          detail: "Returned a web page instead of a stream",
        };
      }
      if (buf.byteLength === 0) {
        return {
          url: rawUrl,
          status: "dead",
          httpStatus: res.status,
          contentType,
          ms,
          detail: "Empty response",
        };
      }
      if (!looksLikeStream) {
        return {
          url: rawUrl,
          status: "dead",
          httpStatus: res.status,
          contentType,
          ms,
          detail: "Response is not a media stream",
        };
      }

      // HLS: parse the playlist and prove at least one segment is alive, otherwise the
      // stream is parkable "expired" content (200 OK but nothing playable).
      if (looksLikeHls) {
        const fullText = new TextDecoder().decode(buf);
        const finalUrl = res.url || url.toString();
        const expiry = await verifyHlsManifest(finalUrl, fullText);
        if (expiry.expired) {
          return {
            url: rawUrl,
            status: "expired",
            httpStatus: res.status,
            contentType,
            ms,
            ...(expiry.detail ? { detail: expiry.detail } : {}),
          };
        }
      }
    }

    return { url: rawUrl, status: "ok", httpStatus: res.status, contentType, ms };
  } catch (e) {
    const aborted =
      e instanceof Error && (e.name === "AbortError" || /abort|timeout/i.test(e.message));
    return {
      url: rawUrl,
      status: aborted ? "timeout" : "dead",
      ms: Date.now() - started,
      detail: e instanceof Error ? e.message.slice(0, 120) : "request failed",
    };
  }
}

/** Check a batch of channel URLs. The client sends batches so progress can be shown. */
export const checkChannels = createServerFn({ method: "POST" })
  .inputValidator((data: { urls: string[]; mode: "quick" | "deep" }) => {
    if (!data || !Array.isArray(data.urls)) throw new Error("A list of channel URLs is required.");
    const urls = data.urls.filter((u) => typeof u === "string").slice(0, MAX_BATCH);
    return { urls, mode: data.mode === "deep" ? ("deep" as const) : ("quick" as const) };
  })
  .handler(async ({ data }) => {
    const concurrency = data.mode === "deep" ? 6 : 12;
    const results: ChannelCheck[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, data.urls.length) }, async () => {
      while (cursor < data.urls.length) {
        const index = cursor++;
        const target = data.urls[index]!;
        results.push(await checkOne(target, data.mode));
      }
    });
    await Promise.all(workers);
    return { results };
  });
