import type { SavedPlaylist } from "./playlist.functions";

const LEGACY_KEY = "iptv.playlists.v1";

export function downloadFile(filename: string, contents: string, mime = "audio/x-mpegurl") {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function safeFileName(name: string, ext: string): string {
  const base =
    name
      .trim()
      .replace(/[^\w\-. ]+/g, "_")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "playlist";
  return `${base}.${ext}`;
}

/** Reads playlists previously stored in localStorage so they can be migrated into db.json. */
export function readLegacyLocalPlaylists(): SavedPlaylist[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedPlaylist[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
