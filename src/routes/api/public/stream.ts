import { createFileRoute } from "@tanstack/react-router";

/**
 * Streaming proxy so the browser can play channels that block cross-origin playback.
 * HLS playlists are rewritten so their segments come back through this same route.
 */

function assertPublicHttpUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported protocol");
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error("private address");
  return u;
}

const PROXY_PATH = "/api/public/stream";

function proxied(target: string): string {
  return `${PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

function rewritePlaylist(text: string, base: URL): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        // Rewrite URI="..." attributes (keys, media, i-frame playlists).
        return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          try {
            return `URI="${proxied(new URL(uri, base).toString())}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      try {
        return proxied(new URL(trimmed, base).toString());
      } catch {
        return line;
      }
    })
    .join("\n");
}

const HOP_BY_HOP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "access-control-allow-origin",
]);

async function handle(request: Request, method: "GET" | "HEAD") {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return new Response("Missing url", { status: 400 });

  let target: URL;
  try {
    target = assertPublicHttpUrl(raw);
  } catch {
    return new Response("Blocked url", { status: 400 });
  }

  const headers: Record<string, string> = {
    "user-agent": "VLC/3.0.20 LibVLC/3.0.20",
    accept: "*/*",
    referer: `${target.protocol}//${target.host}/`,
  };
  const range = request.headers.get("range");
  if (range) headers["range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { method, headers, redirect: "follow" });
  } catch {
    return new Response("Upstream unreachable", { status: 502 });
  }

  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  out.set("access-control-allow-origin", "*");
  out.set("cache-control", "no-store");

  const isPlaylist =
    contentType.includes("mpegurl") ||
    /\.m3u8?(\?|$)/i.test(target.pathname + target.search) ||
    contentType.includes("text/plain");

  if (method === "GET" && isPlaylist && upstream.ok) {
    const text = await upstream.text();
    if (text.includes("#EXTM3U")) {
      const finalUrl = new URL(upstream.url || target.toString());
      out.set("content-type", "application/vnd.apple.mpegurl");
      return new Response(rewritePlaylist(text, finalUrl), { status: upstream.status, headers: out });
    }
    return new Response(text, { status: upstream.status, headers: out });
  }

  if (!out.get("content-type")) out.set("content-type", "video/mp2t");
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}

export const Route = createFileRoute("/api/public/stream")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request, "GET"),
      HEAD: ({ request }) => handle(request, "HEAD"),
      OPTIONS: () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "range",
            "access-control-allow-methods": "GET,HEAD,OPTIONS",
          },
        }),
    },
  },
});
