import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ChannelPlayer } from "@/components/ChannelPlayer";
import { VodSection } from "@/components/VodSection";
import { Badge, Button, Input, Panel, Textarea } from "@/components/ui/primitives";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  buildM3U,
  isValidHttpUrl,
  parseM3U,
  parseUrlList,
  type Channel,
  type ParseIssue,
} from "@/lib/m3u";
import { checkChannels, fetchPlaylist, type ChannelCheck } from "@/lib/m3u.functions";
import {
  deletePlaylist,
  listPlaylists,
  renamePlaylist,
  savePlaylist,
  type SavedPlaylist,
} from "@/lib/playlist.functions";
import { deleteDraft, listDrafts, saveDraft, type Draft } from "@/lib/draft.functions";
import {
  fetchStalkerVod,
  fetchXtreamSeriesEpisodes,
  fetchXtreamVod,
  loginStalker,
  loginXtream,
  type SeriesItem,
  type SeriesSeason,
  type VodItem,
} from "@/lib/panel.functions";
import { downloadFile, readLegacyLocalPlaylists, safeFileName } from "@/lib/playlist-store";

const TITLE = "StreamCheck — IPTV M3U Validator & Playlist Builder";
const DESCRIPTION =
  "Validate M3U IPTV playlists channel by channel, import links or files, then save and export clean playlists with your own name.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});
type SourceEntry = { id: string; label: string; channels: number; errors: number; note?: string };

type Mode = "quick" | "deep";

type ProviderCreds =
  | { type: "xtream"; server: string; username: string; password: string }
  | { type: "stalker"; server: string; mac: string };

function providerMeta(creds: ProviderCreds): Record<string, string> {
  if (creds.type === "xtream") {
    return {
      provider: "xtream",
      server: creds.server,
      username: creds.username,
      password: creds.password,
    };
  }
  return {
    provider: "stalker",
    server: creds.server,
    mac: creds.mac,
  };
}
type StatusFilter = "all" | "ok" | "dead" | "unchecked";

const BATCH = 40;

function Dashboard() {
  const fetchRemote = useServerFn(fetchPlaylist);
  const runChecks = useServerFn(checkChannels);
  const listSaved = useServerFn(listPlaylists);
  const saveSaved = useServerFn(savePlaylist);
  const deleteSaved = useServerFn(deletePlaylist);
  const renameSaved = useServerFn(renamePlaylist);
  const listDraftFns = useServerFn(listDrafts);
  const saveDraftFns = useServerFn(saveDraft);
  const deleteDraftFns = useServerFn(deleteDraft);
  const xtreamLogin = useServerFn(loginXtream);
  const stalkerLogin = useServerFn(loginStalker);
  const xtreamVod = useServerFn(fetchXtreamVod);
  const stalkerVod = useServerFn(fetchStalkerVod);
  const xtreamSeriesEpisodes = useServerFn(fetchXtreamSeriesEpisodes);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [issues, setIssues] = useState<ParseIssue[]>([]);
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [checks, setChecks] = useState<Record<string, ChannelCheck>>({});
  const [mode, setMode] = useState<Mode>("quick");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [singleUrl, setSingleUrl] = useState("");
  const [bulkUrls, setBulkUrls] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [workingOnly, setWorkingOnly] = useState(true);
  const [saved, setSaved] = useState<SavedPlaylist[]>([]);
  const [playing, setPlaying] = useState<Channel | null>(null);
  const [groupExportBusy, setGroupExportBusy] = useState(false);
  const [groupExportOpen, setGroupExportOpen] = useState(true);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [sourceTab, setSourceTab] = useState<"m3u" | "xtream" | "stalker">("m3u");
  const [xtreamServer, setXtreamServer] = useState("");
  const [xtreamUser, setXtreamUser] = useState("");
  const [xtreamPass, setXtreamPass] = useState("");
  const [stalkerServer, setStalkerServer] = useState("");
  const [stalkerMac, setStalkerMac] = useState("");
  const [movies, setMovies] = useState<VodItem[]>([]);
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [providerCreds, setProviderCreds] = useState<ProviderCreds | null>(null);
  const cancelRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const sourcesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (playing) playerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [playing]);

  const notify = useCallback(
    (tone: "ok" | "error", text: string) => setMessage({ tone, text }),
    [],
  );

  const loadSaved = useCallback(async () => {
    try {
      const playlists = await listSaved();
      const entries = Array.isArray(playlists) ? playlists : [];
      setSaved(entries);
      return entries;
    } catch {
      notify("error", "Could not load saved playlists.");
      setSaved([]);
      return [];
    }
  }, [listSaved, notify]);

  useEffect(() => {
    void (async () => {
      const existing = await loadSaved();
      if (existing.length > 0) return;
      const legacy = readLegacyLocalPlaylists();
      if (legacy.length === 0) return;
      for (const p of legacy) {
        try {
          await saveSaved({
            data: {
              name: p.name,
              channels: p.channels,
              ...(p.source ? { source: p.source } : {}),
            },
          });
        } catch {
          // skip entries that fail to migrate
        }
      }
      await loadSaved();
      notify("ok", `Migrated ${legacy.length} playlists from this browser into db.json.`);
    })();
  }, [loadSaved, notify, saveSaved]);

  const loadDrafts = useCallback(async () => {
    try {
      const list = await listDraftFns();
      setDrafts(Array.isArray(list) ? list : []);
    } catch {
      notify("error", "Could not load drafts.");
      setDrafts([]);
    }
  }, [listDraftFns, notify]);

  useEffect(() => {
    void loadDrafts();
  }, [loadDrafts]);

  const ingest = useCallback((text: string, label: string) => {
    const parsed = parseM3U(text);
    const errors = parsed.issues.filter((i) => i.severity === "error").length;
    setChannels((prev) => {
      const seen = new Set(prev.map((c) => c.url));
      const fresh = parsed.channels.filter((c) => !seen.has(c.url));
      return [...prev, ...fresh.map((c, i) => ({ ...c, id: `${label}-${prev.length + i}` }))];
    });
    setIssues((prev) => [
      ...prev,
      ...parsed.issues.map((i) => ({ ...i, message: `${label}: ${i.message}` })),
    ]);
    setSources((prev) => [
      ...prev,
      { id: `${label}-${Date.now()}`, label, channels: parsed.channels.length, errors },
    ]);
    return parsed;
  }, []);

  async function addSingleUrl(url: string) {
    if (!isValidHttpUrl(url)) {
      notify("error", "Enter a full link starting with http:// or https://");
      return;
    }
    setBusy(true);
    try {
      const res = await fetchRemote({ data: { url } });
      const parsed = ingest(res.text, new URL(res.finalUrl).hostname);
      notify(
        "ok",
        `Loaded ${parsed.channels.length} channels from ${new URL(res.finalUrl).hostname}.`,
      );
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Could not load that link.");
    } finally {
      setBusy(false);
    }
  }

  async function addBulkUrls() {
    const urls = parseUrlList(bulkUrls);
    if (urls.length === 0) {
      notify("error", "Paste one playlist link per line.");
      return;
    }
    setBusy(true);
    let loaded = 0;
    for (const url of urls) {
      try {
        const res = await fetchRemote({ data: { url } });
        ingest(res.text, new URL(res.finalUrl).hostname);
        loaded++;
      } catch (e) {
        setSources((prev) => [
          ...prev,
          {
            id: `${url}-${Date.now()}`,
            label: url.slice(0, 48),
            channels: 0,
            errors: 1,
            note: e instanceof Error ? e.message : "failed",
          },
        ]);
      }
    }
    setBusy(false);
    setBulkUrls("");
    notify(loaded ? "ok" : "error", `${loaded} of ${urls.length} links loaded.`);
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const text = await file.text();
      if (/\.(m3u|m3u8)$/i.test(file.name) || text.trimStart().startsWith("#EXTM3U")) {
        ingest(text, file.name);
      } else {
        const urls = parseUrlList(text);
        if (urls.length === 0) {
          notify("error", `${file.name} has no playlist links or channels.`);
          continue;
        }
        setBulkUrls((prev) => (prev ? `${prev}\n${urls.join("\n")}` : urls.join("\n")));
        notify(
          "ok",
          `${urls.length} links from ${file.name} added below — press "Fetch all links".`,
        );
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function runXtream(server: string, username: string, password: string, replace: boolean) {
    setBusy(true);
    try {
      const res = await xtreamLogin({ data: { server, username, password } });
      const parsed = parseM3U(res.text);
      const parsedChannels = parsed.channels.map((c, i) => ({ ...c, id: `xtream-${i}` }));
      setChannels((prev) => {
        const seen = new Set(replace ? [] : prev.map((c) => c.url));
        const merged = replace ? [] : prev;
        return [...merged, ...parsedChannels.filter((c) => !seen.has(c.url))];
      });
      const errors = parsed.issues.filter((i) => i.severity === "error").length;
      const source = {
        id: `xtream-${Date.now()}`,
        label: `Xtream · ${new URL(res.finalUrl).hostname}`,
        channels: res.count,
        errors,
      };
      setSources((prev) => (replace ? [source] : [...prev, source]));
      setProviderCreds({ type: "xtream", server: res.finalUrl, username, password });
      notify("ok", `Loaded ${res.count} channels from Xtream Codes.`);
      try {
        const vod = await xtreamVod({ data: { server, username, password } });
        setMovies(vod.movies);
        setSeries(vod.series);
      } catch {
        // VOD/series are optional — live channels still work without them.
      }
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Xtream login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleXtreamLogin() {
    if (!xtreamServer.trim() || !xtreamUser.trim() || !xtreamPass.trim()) {
      notify("error", "Server, username, and password are required.");
      return;
    }
    void runXtream(xtreamServer, xtreamUser, xtreamPass, false);
  }

  async function runStalker(server: string, mac: string, replace: boolean) {
    setBusy(true);
    try {
      const res = await stalkerLogin({ data: { server, mac } });
      const parsed = parseM3U(res.text);
      const parsedChannels = parsed.channels.map((c, i) => ({ ...c, id: `stalker-${i}` }));
      setChannels((prev) => {
        const seen = new Set(replace ? [] : prev.map((c) => c.url));
        const merged = replace ? [] : prev;
        return [...merged, ...parsedChannels.filter((c) => !seen.has(c.url))];
      });
      const errors = parsed.issues.filter((i) => i.severity === "error").length;
      const source = {
        id: `stalker-${Date.now()}`,
        label: `Stalker · ${new URL(res.finalUrl).hostname}`,
        channels: res.count,
        errors,
      };
      setSources((prev) => (replace ? [source] : [...prev, source]));
      setProviderCreds({ type: "stalker", server: res.finalUrl, mac });
      notify("ok", `Loaded ${res.count} channels from Stalker Portal.`);
      try {
        const vod = await stalkerVod({ data: { server, mac } });
        setMovies(vod.movies);
        setSeries(vod.series);
      } catch {
        // VOD/series are optional — live channels still work without them.
      }
    } catch (e) {
      notify("error", e instanceof Error ? e.message : "Stalker login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleStalkerLogin() {
    if (!stalkerServer.trim() || !stalkerMac.trim()) {
      notify("error", "Server URL and MAC address are required.");
      return;
    }
    void runStalker(stalkerServer, stalkerMac, false);
  }

  const loadSeriesEpisodes = useCallback(
    async (s: SeriesItem): Promise<SeriesItem> => {
      try {
        const { seasons } = await xtreamSeriesEpisodes({
          data: {
            server: xtreamServer,
            username: xtreamUser,
            password: xtreamPass,
            seriesId: s.id,
          },
        });
        const updated = { ...s, seasons };
        setSeries((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
        return updated;
      } catch {
        notify("error", "Could not load episodes for this series.");
        return s;
      }
    },
    [notify, xtreamSeriesEpisodes, xtreamServer, xtreamUser, xtreamPass],
  );

  const saveChannelsToPlaylist = useCallback(
    async (items: Channel[], defaultName: string) => {
      if (items.length === 0) {
        notify("error", "Nothing to save.");
        return;
      }
      try {
        const entry = await saveSaved({
          data: {
            name: playlistName || defaultName,
            channels: items,
            source: sources.map((s) => s.label).join(", "),
            ...(providerCreds ? providerMeta(providerCreds) : {}),
          },
        });
        await loadSaved();
        notify("ok", `Saved "${entry.name}" with ${items.length} items.`);
      } catch (e) {
        notify("error", e instanceof Error ? e.message : "Could not save the playlist.");
      }
    },
    [playlistName, saveSaved, loadSaved, notify, sources, providerCreds],
  );

  async function validate(target: Channel[]) {
    if (target.length === 0) {
      notify("error", "Import a playlist first.");
      return;
    }
    cancelRef.current = false;
    setBusy(true);
    setProgress({ done: 0, total: target.length });
    const urls = target.map((c) => c.url);
    for (let i = 0; i < urls.length; i += BATCH) {
      if (cancelRef.current) break;
      const slice = urls.slice(i, i + BATCH);
      try {
        const { results } = await runChecks({ data: { urls: slice, mode } });
        setChecks((prev) => {
          const next = { ...prev };
          for (const r of results) next[r.url] = r;
          return next;
        });
      } catch {
        notify("error", "A validation batch failed. Try again.");
      }
      setProgress({ done: Math.min(i + BATCH, urls.length), total: urls.length });
    }
    setBusy(false);
    setProgress(null);
  }

  const stats = useMemo(() => {
    let ok = 0;
    let dead = 0;
    for (const c of channels) {
      const r = checks[c.url];
      if (!r) continue;
      if (r.status === "ok") ok++;
      else dead++;
    }
    return { total: channels.length, ok, dead, unchecked: channels.length - ok - dead };
  }, [channels, checks]);

  const allGroups = useMemo(() => {
    const map = new Map<string, { total: number; working: number }>();
    for (const c of channels) {
      const key = c.group ?? "Ungrouped";
      const entry = map.get(key) ?? { total: 0, working: 0 };
      entry.total++;
      if (checks[c.url]?.status === "ok") entry.working++;
      map.set(key, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [channels, checks]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return channels
      .filter((c) => {
        const r = checks[c.url];
        if (filter === "ok" && r?.status !== "ok") return false;
        if (filter === "dead" && (!r || r.status === "ok")) return false;
        if (filter === "unchecked" && r) return false;
        if (q && !(c.name.toLowerCase().includes(q) || (c.group ?? "").toLowerCase().includes(q)))
          return false;
        return true;
      })
      .slice(0, 400);
  }, [channels, checks, filter, search]);

  function currentSelection(): Channel[] {
    return workingOnly ? channels.filter((c) => checks[c.url]?.status === "ok") : channels;
  }

  function handleSave() {
    const selection = currentSelection();
    if (selection.length === 0) {
      notify(
        "error",
        workingOnly ? "No working channels yet — run validation first." : "Nothing to save.",
      );
      return;
    }
    void (async () => {
      try {
        const entry = await saveSaved({
          data: {
            name: playlistName,
            channels: selection,
            source: sources.map((s) => s.label).join(", "),
            ...(providerCreds ? providerMeta(providerCreds) : {}),
          },
        });
        await loadSaved();
        setPlaylistName("");
        notify("ok", `Saved "${entry.name}" with ${selection.length} channels.`);
      } catch (e) {
        notify("error", e instanceof Error ? e.message : "Could not save the playlist.");
      }
    })();
  }

  function exportNow() {
    const selection = currentSelection();
    if (selection.length === 0) {
      notify("error", "Nothing to export yet.");
      return;
    }
    downloadFile(safeFileName(playlistName || "streamcheck-playlist", "m3u"), buildM3U(selection));
  }

  function exportGroup(name: string) {
    const groupChannels = channels.filter((c) => (c.group ?? "Ungrouped") === name);
    if (groupChannels.length === 0) {
      notify("error", "That group has no channels to export.");
      return;
    }
    downloadFile(safeFileName(`iptv-${name}`, "m3u"), buildM3U(groupChannels));
  }

  async function exportAllGroups() {
    if (allGroups.length === 0) return;
    setGroupExportBusy(true);
    let exported = 0;
    for (const [name] of allGroups) {
      const groupChannels = channels.filter((c) => (c.group ?? "Ungrouped") === name);
      if (groupChannels.length === 0) continue;
      downloadFile(safeFileName(`iptv-${name}`, "m3u"), buildM3U(groupChannels));
      exported++;
      await new Promise((r) => setTimeout(r, 250));
    }
    setGroupExportBusy(false);
    notify("ok", `Exported ${exported} group files.`);
  }

  function loadSavedPlaylist(p: SavedPlaylist) {
    const movieEntries = p.channels.filter((c) => c.kind === "movie");
    const seriesEntries = p.channels.filter((c) => c.kind === "series");
    const liveEntries = p.channels.filter((c) => !c.kind || c.kind === "live");

    if (movieEntries.length > 0) {
      setMovies(
        movieEntries.map((c) => ({
          id: c.id,
          name: c.name,
          url: c.url,
          ...(c.group ? { group: c.group } : {}),
          ...(c.logo ? { logo: c.logo } : {}),
          ...(c.tvgId ? { tvgId: c.tvgId } : {}),
        })),
      );
    } else {
      setMovies([]);
    }

    if (seriesEntries.length > 0) {
      const bySeries = new Map<string, Channel[]>();
      for (const c of seriesEntries) {
        const key = c.series ?? "Series";
        const arr = bySeries.get(key) ?? [];
        arr.push(c);
        bySeries.set(key, arr);
      }
      const reconstructed: SeriesItem[] = [...bySeries.entries()].map(([name, epChannels]) => {
        const bySeason = new Map<
          number,
          { id: string; name: string; url: string; logo?: string }[]
        >();
        for (const ep of epChannels) {
          const num = ep.season ?? 1;
          const arr = bySeason.get(num) ?? [];
          arr.push({
            id: ep.id,
            name: ep.name,
            url: ep.url,
            ...(ep.logo ? { logo: ep.logo } : {}),
          });
          bySeason.set(num, arr);
        }
        const seasons: SeriesSeason[] = [...bySeason.entries()]
          .map(([num, episodes]) => ({ season: num, name: `Season ${num}`, episodes }))
          .sort((a, b) => a.season - b.season);
        const first = epChannels[0];
        return {
          id: name,
          name,
          ...(first?.group ? { group: first.group } : {}),
          ...(first?.logo ? { logo: first.logo } : {}),
          seasons,
        };
      });
      setSeries(reconstructed);
    } else {
      setSeries([]);
    }

    setChannels(liveEntries);
    setIssues([]);

    const creds =
      p.provider === "xtream" && p.server && p.username && p.password
        ? ({
            type: "xtream",
            server: p.server,
            username: p.username,
            password: p.password,
          } as const)
        : p.provider === "stalker" && p.server && p.mac
          ? ({ type: "stalker", server: p.server, mac: p.mac } as const)
          : null;

    if (creds) {
      setSources([{ id: p.id, label: p.name, channels: p.channels.length, errors: 0 }]);
      setProviderCreds(creds);
      if (creds.type === "xtream") {
        setSourceTab("xtream");
        setXtreamServer(creds.server);
        setXtreamUser(creds.username);
        setXtreamPass(creds.password);
      } else {
        setSourceTab("stalker");
        setStalkerServer(creds.server);
        setStalkerMac(creds.mac);
      }
      scrollToSources();
      notify(
        "ok",
        `Loaded "${p.name}" — reconnecting to ${creds.type === "xtream" ? "Xtream Codes" : "Stalker Portal"} to refresh your data.`,
      );
      if (creds.type === "xtream") {
        void runXtream(creds.server, creds.username, creds.password, true);
      } else {
        void runStalker(creds.server, creds.mac, true);
      }
      return;
    }

    setSources([{ id: p.id, label: p.name, channels: p.channels.length, errors: 0 }]);
    notify("ok", `Loaded "${p.name}" into the workspace.`);
  }

  function scrollToSources() {
    requestAnimationFrame(() => {
      sourcesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function resetWorkspace() {
    setChannels([]);
    setIssues([]);
    setSources([]);
    setChecks({});
    setMovies([]);
    setSeries([]);
    setProviderCreds(null);
  }

  function resetAll() {
    resetWorkspace();
    notify("ok", "Workspace cleared.");
  }

  const errorIssues = issues.filter((i) => i.severity === "error");
  const warnIssues = issues.filter((i) => i.severity === "warning");

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] tracking-[0.25em] text-primary uppercase">
            Streamcheck
          </p>
          <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">IPTV playlist validator</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Import M3U links or files, check every channel strictly, then save and export a clean
            playlist under your own name.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={resetAll}>
            Clear workspace
          </Button>
        </div>
      </header>

      {message && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            message.tone === "ok"
              ? "border-success/40 bg-success/10 text-success"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <div ref={sourcesRef}>
            <Panel
              title="Add sources"
              subtitle="Import from M3U links, Xtream Codes, or Stalker Portal."
            >
              <div className="space-y-4">
                <div className="flex rounded-lg border border-border p-1">
                  {(
                    [
                      { key: "m3u", label: "M3U Link" },
                      { key: "xtream", label: "Xtream Codes" },
                      { key: "stalker", label: "Stalker Portal" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setSourceTab(t.key)}
                      className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                        sourceTab === t.key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {sourceTab === "m3u" && (
                  <>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        value={singleUrl}
                        onChange={(e) => setSingleUrl(e.target.value)}
                        placeholder="https://example.com/playlist.m3u"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addSingleUrl(singleUrl);
                        }}
                      />
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => void addSingleUrl(singleUrl)}
                      >
                        Fetch link
                      </Button>
                    </div>
                    <div>
                      <label className="mb-2 block text-xs font-medium text-muted-foreground">
                        Multiple playlist links (one per line)
                      </label>
                      <Textarea
                        rows={4}
                        value={bulkUrls}
                        onChange={(e) => setBulkUrls(e.target.value)}
                        placeholder={
                          "https://host-a.tv/list.m3u\nhttps://host-b.tv/get.php?type=m3u_plus"
                        }
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <Button size="sm" disabled={busy} onClick={() => void addBulkUrls()}>
                          Fetch all links
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {parseUrlList(bulkUrls).length} valid links
                        </span>
                      </div>
                    </div>
                    <div className="rounded-lg border border-dashed border-border p-4 text-center">
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".m3u,.m3u8,.txt,text/plain"
                        multiple
                        className="hidden"
                        onChange={(e) => void handleFiles(e.target.files)}
                      />
                      <p className="text-sm">Upload .m3u, .m3u8 or .txt files</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Playlists are parsed directly; text files of links are queued above.
                      </p>
                      <Button size="sm" className="mt-3" onClick={() => fileRef.current?.click()}>
                        Choose files
                      </Button>
                    </div>
                  </>
                )}

                {sourceTab === "xtream" && (
                  <div className="space-y-3">
                    <Input
                      value={xtreamServer}
                      onChange={(e) => setXtreamServer(e.target.value)}
                      placeholder="http://panel.example.com:8080"
                    />
                    <Input
                      value={xtreamUser}
                      onChange={(e) => setXtreamUser(e.target.value)}
                      placeholder="Username"
                    />
                    <Input
                      value={xtreamPass}
                      onChange={(e) => setXtreamPass(e.target.value)}
                      type="password"
                      placeholder="Password"
                    />
                    <Button
                      variant="primary"
                      className="w-full"
                      disabled={busy}
                      onClick={() => void handleXtreamLogin()}
                    >
                      {busy ? "Connecting…" : "Connect & load streams"}
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Authenticates with the Xtream Codes API, fetches all live stream categories
                      and channels, then loads them into the workspace for validation.
                    </p>
                  </div>
                )}

                {sourceTab === "stalker" && (
                  <div className="space-y-3">
                    <Input
                      value={stalkerServer}
                      onChange={(e) => setStalkerServer(e.target.value)}
                      placeholder="http://portal.example.com"
                    />
                    <Input
                      value={stalkerMac}
                      onChange={(e) => setStalkerMac(e.target.value)}
                      placeholder="00:1A:79:XX:XX:XX"
                    />
                    <Button
                      variant="primary"
                      className="w-full"
                      disabled={busy}
                      onClick={() => void handleStalkerLogin()}
                    >
                      {busy ? "Connecting…" : "Connect & load streams"}
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Authenticates with the Stalker/Ministra portal using your MAC address,
                      retrieves the channel list, and loads it into the workspace.
                    </p>
                  </div>
                )}

                {sources.length > 0 && (
                  <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {sources.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                      >
                        <span className="truncate font-mono">{s.label}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge tone="accent">{s.channels} channels</Badge>
                          {s.errors > 0 && (
                            <Badge tone="danger">{s.note ?? `${s.errors} errors`}</Badge>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          </div>

          <Panel
            title="Validation"
            subtitle="Quick scan checks structure and reachability. Deep check opens each stream and inspects the data."
          >
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-border p-1">
                {(["quick", "deep"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      mode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "quick" ? "Quick scan" : "Deep check"}
                  </button>
                ))}
              </div>
              <Button variant="primary" disabled={busy} onClick={() => void validate(channels)}>
                Validate all channels
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void validate(channels.filter((c) => !checks[c.url]))}
              >
                Only unchecked
              </Button>
              {busy && progress && (
                <Button size="sm" variant="danger" onClick={() => (cancelRef.current = true)}>
                  Stop
                </Button>
              )}
            </div>

            {progress && (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Checked {progress.done} of {progress.total}
                </p>
              </div>
            )}

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Channels", value: stats.total, tone: "text-foreground" },
                { label: "Working", value: stats.ok, tone: "text-success" },
                { label: "Failed", value: stats.dead, tone: "text-destructive" },
                { label: "Unchecked", value: stats.unchecked, tone: "text-muted-foreground" },
              ].map((s) => (
                <div
                  key={s.label}
                  className="rounded-lg border border-border bg-surface/60 px-3 py-3"
                >
                  <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">
                    {s.label}
                  </dt>
                  <dd className={`mt-1 font-display text-2xl font-semibold ${s.tone}`}>
                    {s.value}
                  </dd>
                </div>
              ))}
            </dl>

            {(errorIssues.length > 0 || warnIssues.length > 0) && (
              <div className="mt-5 rounded-lg border border-border bg-surface/50 p-3">
                <p className="text-xs font-medium">
                  Playlist format: {errorIssues.length} errors, {warnIssues.length} warnings
                </p>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto font-mono text-[11px] text-muted-foreground">
                  {[...errorIssues, ...warnIssues].slice(0, 40).map((i, idx) => (
                    <li key={idx}>
                      <span
                        className={i.severity === "error" ? "text-destructive" : "text-warning"}
                      >
                        line {i.line}
                      </span>{" "}
                      — {i.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          <VodSection
            movies={movies}
            series={series}
            loadSeriesEpisodes={loadSeriesEpisodes}
            onSave={saveChannelsToPlaylist}
          />

          <Panel
            title="Channels"
            subtitle={`${visible.length} shown${channels.length > visible.length ? ` of ${channels.length}` : ""}`}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or group"
                  className="w-44"
                />
                {(["all", "ok", "dead", "unchecked"] as StatusFilter[]).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={filter === f ? "primary" : "ghost"}
                    onClick={() => setFilter(f)}
                  >
                    {f === "ok" ? "working" : f}
                  </Button>
                ))}
              </div>
            }
          >
            {channels.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No channels yet. Add a playlist link or upload a file above.
              </p>
            ) : (
              <div className="max-h-[540px] overflow-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-surface text-[11px] tracking-wide text-muted-foreground uppercase">
                    <tr>
                      <th className="px-3 py-2 font-medium">Channel</th>
                      <th className="px-3 py-2 font-medium">Group</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Detail</th>
                      <th className="px-3 py-2 font-medium">Play</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visible.map((c) => {
                      const r = checks[c.url];
                      return (
                        <tr
                          key={c.id}
                          className={`hover:bg-secondary/40 ${playing?.url === c.url ? "bg-primary/10" : ""}`}
                        >
                          <td className="max-w-[260px] px-3 py-2">
                            <p className="truncate font-medium">{c.name}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {c.url}
                            </p>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {c.group ?? "—"}
                          </td>
                          <td className="px-3 py-2">
                            {!r ? (
                              <Badge>not checked</Badge>
                            ) : r.status === "ok" ? (
                              <Badge tone="success">working · {r.ms}ms</Badge>
                            ) : r.status === "timeout" ? (
                              <Badge tone="warning">timeout</Badge>
                            ) : (
                              <Badge tone="danger">{r.status}</Badge>
                            )}
                          </td>
                          <td className="max-w-[220px] truncate px-3 py-2 text-[11px] text-muted-foreground">
                            {r?.detail ?? (r?.httpStatus ? `HTTP ${r.httpStatus}` : "—")}
                          </td>
                          <td className="px-3 py-2">
                            <Button
                              size="sm"
                              variant={playing?.url === c.url ? "primary" : "secondary"}
                              aria-label={`Play ${c.name}`}
                              onClick={() => setPlaying(c)}
                            >
                              ▶ Play
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {playing && (
              <div ref={playerRef}>
                <ChannelPlayer channel={playing} onClose={() => setPlaying(null)} />
              </div>
            )}
          </Panel>
        </div>

        <aside className="space-y-5">
          <Panel
            title="Save playlist"
            subtitle="Stored in this browser and exportable as an .m3u file."
          >
            <div className="space-y-3">
              <Input
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                placeholder="My sports channels"
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={workingOnly}
                  onChange={(e) => setWorkingOnly(e.target.checked)}
                  className="size-4 accent-[oklch(0.86_0.19_124)]"
                />
                Include only channels that passed validation ({stats.ok})
              </label>
              <div className="flex gap-2">
                <Button variant="primary" className="flex-1" onClick={handleSave}>
                  Save
                </Button>
                <Button className="flex-1" onClick={exportNow}>
                  Export .m3u
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="w-full"
                disabled={channels.length === 0}
                onClick={async () => {
                  if (channels.length === 0) {
                    notify("error", "Nothing to save as draft.");
                    return;
                  }
                  setDraftBusy(true);
                  try {
                    const content = buildM3U(
                      workingOnly
                        ? channels.filter((c) => checks[c.url]?.status === "ok")
                        : channels,
                    );
                    if (!content.trim()) {
                      notify("error", "No channels to save as draft.");
                      return;
                    }
                    await saveDraftFns({
                      data: {
                        name: playlistName.trim() || "Untitled draft",
                        content,
                      },
                    });
                    await loadDrafts();
                    notify("ok", "Saved as draft.");
                  } catch (e) {
                    notify("error", e instanceof Error ? e.message : "Could not save draft.");
                  } finally {
                    setDraftBusy(false);
                  }
                }}
              >
                Save as Draft
              </Button>
            </div>
          </Panel>

          <Panel title="Saved playlists" subtitle={`${saved.length} in this browser`}>
            {saved.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing saved yet.</p>
            ) : (
              <ul className="space-y-3">
                {saved.map((p) => (
                  <li key={p.id} className="rounded-lg border border-border bg-surface/50 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{p.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {p.channels.length} channels · {new Date(p.createdAt).toLocaleString()}
                          {p.provider === "xtream" && " · creds saved"}
                          {p.provider === "stalker" && " · portal saved"}
                        </p>
                      </div>
                      {p.provider === "xtream" ? (
                        <Badge tone="accent">Xtream</Badge>
                      ) : p.provider === "stalker" ? (
                        <Badge tone="accent">Stalker</Badge>
                      ) : (
                        <Badge tone="accent">m3u</Badge>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          downloadFile(safeFileName(p.name, "m3u"), buildM3U(p.channels))
                        }
                      >
                        Export
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => loadSavedPlaylist(p)}>
                        Load
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const next = window.prompt("New name", p.name);
                          if (!next) return;
                          void (async () => {
                            try {
                              await renameSaved({ data: { id: p.id, name: next } });
                              await loadSaved();
                            } catch {
                              notify("error", "Could not rename the playlist.");
                            }
                          })();
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          void (async () => {
                            try {
                              await deleteSaved({ data: { id: p.id } });
                              await loadSaved();
                            } catch {
                              notify("error", "Could not delete the playlist.");
                            }
                          })();
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Drafts" subtitle={`${drafts.length} saved`}>
            {drafts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No drafts yet.</p>
            ) : (
              <ul className="space-y-3">
                {drafts.map((d) => (
                  <li key={d.id} className="rounded-lg border border-border bg-surface/50 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{d.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {new Date(d.updatedAt).toLocaleString()}
                        </p>
                      </div>
                      <Badge tone="muted">draft</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          const parsed = parseM3U(d.content);
                          const parsedChannels = parsed.channels.map((c, i) => ({
                            ...c,
                            id: `draft-${i}`,
                          }));
                          setChannels((prev) => {
                            const seen = new Set(prev.map((c) => c.url));
                            return [...prev, ...parsedChannels.filter((c) => !seen.has(c.url))];
                          });
                          setSources((prev) => [
                            ...prev,
                            {
                              id: d.id,
                              label: d.name,
                              channels: parsedChannels.length,
                              errors: parsed.issues.filter((i) => i.severity === "error").length,
                            },
                          ]);
                          notify("ok", `Loaded "${d.name}" into workspace.`);
                        }}
                      >
                        Load
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          try {
                            await deleteDraftFns({ data: { id: d.id } });
                            await loadDrafts();
                          } catch {
                            notify("error", "Could not delete draft.");
                          }
                        }}
                      >
                        Delete
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => downloadFile(safeFileName(d.name, "m3u"), d.content)}
                      >
                        Export
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {allGroups.length > 0 && (
            <Collapsible open={groupExportOpen} onOpenChange={setGroupExportOpen} className="panel">
              <div className="p-5">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center justify-between gap-3 text-left select-none"
                  >
                    <div>
                      <h2 className="text-base font-semibold">Export by Group</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Download a separate .m3u file for every channel group.
                      </p>
                    </div>
                    <ChevronDown
                      className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                        groupExportOpen ? "" : "-rotate-90"
                      }`}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">{allGroups.length} groups</span>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={groupExportBusy}
                      onClick={() => void exportAllGroups()}
                    >
                      {groupExportBusy ? "Exporting…" : "Export all"}
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-2 text-sm">
                    {allGroups.map(([name, { total, working }]) => (
                      <li key={name} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {total} channels · {working} working
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone="muted">{total}</Badge>
                          <Button size="sm" variant="secondary" onClick={() => exportGroup(name)}>
                            Export
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )}
        </aside>
      </div>
    </main>
  );
}
