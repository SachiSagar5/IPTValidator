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

/** Copies text to the clipboard, falling back to a legacy execCommand path. */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to the legacy path
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("Clipboard write failed.");
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
