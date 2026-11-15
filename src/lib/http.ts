/**
 * Shared outbound-HTTP helpers.
 *
 * The validator talks to third-party IPTV panels that frequently sit behind
 * Cloudflare. When such a request fails the response body is usually a large
 * HTML interstitial (a bot challenge, or a zone-level takedown notice). Dumping
 * that markup straight into the UI is noisy and confusing, so these helpers
 * decode failures into one short, actionable sentence.
 */

/** User agent that IPTV panels expect for player traffic. */
export const PLAYER_USER_AGENT = "VLC/3.0.20 LibVLC/3.0.20";

/** Fallback user agent used when Cloudflare rejects the player agent. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function playerHeaders(accept = "*/*"): Record<string, string> {
  return { "user-agent": PLAYER_USER_AGENT, accept };
}

export function browserHeaders(
  accept = "application/json, text/plain, */*",
): Record<string, string> {
  return {
    "user-agent": BROWSER_USER_AGENT,
    accept,
    "accept-language": "en-US,en;q=0.9",
  };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function firstErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  for (const key of ["error", "message", "msg"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const nested = firstErrorMessage(v);
      if (nested) return nested;
    }
  }
  for (const key of ["js", "data"]) {
    const v = rec[key];
    if (v && typeof v === "object") {
      const nested = firstErrorMessage(v);
      if (nested) return nested;
    }
  }
  return null;
}

export function responseErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "empty response";
  try {
    const msg = firstErrorMessage(JSON.parse(trimmed));
    return msg ?? truncate(trimmed, 300);
  } catch {
    // Not JSON — strip HTML down to readable text.
    const stripped = trimmed
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return truncate(stripped || trimmed, 300);
  }
}

export function statusLabel(res: Response): string {
  return res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
}

/** True when a response body looks like any Cloudflare-generated page. */
export function looksLikeCloudflare(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("cloudflare") ||
    lower.includes("cf-error-details") ||
    lower.includes("cf-ray") ||
    lower.includes("__cf_chl") ||
    lower.includes("challenge-platform") ||
    lower.includes("ray id")
  );
}

/**
 * Turn a Cloudflare interstitial into a plain-English explanation, or `null`
 * when the body is not a Cloudflare page we recognise.
 */
export function cloudflareBlockMessage(text: string): string | null {
  if (!looksLikeCloudflare(text)) return null;
  const lower = text.toLowerCase();

  // Zone-level takedown: nothing a client can do will get through.
  if (lower.includes("terms of service violations") || lower.includes("website access blocked")) {
    const zone = /the affected zone is\s*([^\s.<]+)/i.exec(text)?.[1];
    const where = zone ? ` (${zone})` : "";
    return `Blocked by Cloudflare${where}: this server has been taken offline for Terms of Service violations, so it can no longer be reached. Try a different server.`;
  }

  // Bot-management challenge: a real browser can pass, an automated request cannot.
  if (
    lower.includes("just a moment") ||
    lower.includes("checking your browser") ||
    lower.includes("enable javascript and cookies") ||
    lower.includes("challenge-platform") ||
    lower.includes("__cf_chl")
  ) {
    return "Cloudflare is running a browser check on this server, so it could not be read automatically. Open the link in a browser, or try again in a moment.";
  }

  if (
    lower.includes("attention required") ||
    lower.includes("access denied") ||
    lower.includes("you have been blocked")
  ) {
    return "Cloudflare denied access to this server (403). It may be blocking automated requests from this network.";
  }

  return null;
}

/**
 * Human-readable message for a failed HTTP response, preferring a concise
 * Cloudflare explanation over the raw body.
 */
export function describeHttpFailure(res: Response, text: string): string {
  return (
    cloudflareBlockMessage(text) ??
    `Server returned ${statusLabel(res)} — ${responseErrorDetail(text)}`
  );
}
