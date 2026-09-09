import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { ChannelPlayer } from "@/components/ChannelPlayer";
import { Button } from "@/components/ui/primitives";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { Channel } from "@/lib/m3u";
import type { SeriesItem, SeriesSeason, VodItem } from "@/lib/panel.functions";

const MOVIES_PER_PAGE = 50;
const SERIES_PER_PAGE = 24;

function Poster({
  src,
  name,
  className,
}: {
  src?: string | undefined;
  name: string;
  className?: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 to-accent/20",
          className,
        )}
      >
        <span className="px-2 text-center text-[11px] leading-tight font-medium text-foreground/70">
          {name}
        </span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("h-full w-full object-cover", className)}
    />
  );
}

function Pager({
  page,
  pages,
  onPage,
  total,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  total: number;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{total} items</span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          Prev
        </Button>
        <span className="text-xs text-muted-foreground">
          {page} / {pages}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pages}
          onClick={() => onPage(Math.min(pages, page + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function GroupChips({
  groups,
  value,
  onChange,
}: {
  groups: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const all = ["All", ...groups];
  return (
    <div className="flex flex-wrap gap-2">
      {all.map((g) => (
        <button
          key={g}
          onClick={() => onChange(g)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            value === g
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {g}
        </button>
      ))}
    </div>
  );
}

function EpisodeRow({
  episode,
  onPlay,
}: {
  episode: { id: string; name: string; url: string; logo?: string };
  onPlay: (c: Channel) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        onPlay({
          id: `ep-${episode.id}`,
          name: episode.name,
          url: episode.url,
          ...(episode.logo ? { logo: episode.logo } : {}),
        })
      }
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface/40 px-3 py-2 text-left transition-colors hover:bg-secondary/50"
    >
      {episode.logo && !failed ? (
        <img
          src={episode.logo}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-10 w-16 shrink-0 rounded object-cover"
        />
      ) : (
        <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-primary/15 text-[10px] font-semibold text-primary">
          Play
        </div>
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{episode.name}</span>
      <span className="text-[11px] text-muted-foreground">▶</span>
    </button>
  );
}

function CollapsiblePanel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="panel overflow-hidden">
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 text-left select-none"
            >
              <div className="min-w-0">
                <h2 className="text-base font-semibold">{title}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
              </div>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open ? "" : "-rotate-90",
                )}
              />
            </button>
          </CollapsibleTrigger>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        <CollapsibleContent>
          <div className="mt-4">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function MoviesPanel({
  movies,
  onPlay,
  onSave,
}: {
  movies: VodItem[];
  onPlay: (c: Channel) => void;
  onSave: (channels: Channel[], defaultName: string) => void;
}) {
  const [group, setGroup] = useState("All");
  const [page, setPage] = useState(1);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const m of movies) set.add(m.group ?? "Ungrouped");
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [movies]);

  const filtered = useMemo(
    () => movies.filter((m) => group === "All" || (m.group ?? "Ungrouped") === group),
    [movies, group],
  );

  const pages = Math.max(1, Math.ceil(filtered.length / MOVIES_PER_PAGE));
  const visible = filtered.slice((page - 1) * MOVIES_PER_PAGE, page * MOVIES_PER_PAGE);

  const toChannels = (list: VodItem[]): Channel[] =>
    list.map((m) => ({
      id: `mov-${m.id}`,
      name: m.name,
      url: m.url,
      kind: "movie",
      ...(m.group ? { group: m.group } : {}),
      ...(m.logo ? { logo: m.logo } : {}),
    }));

  return (
    <CollapsiblePanel
      title="Movies"
      subtitle={`${movies.length} available in this login`}
      action={
        filtered.length > 0 ? (
          <Button
            size="sm"
            onClick={() =>
              onSave(toChannels(filtered), group === "All" ? "Movies" : `Movies · ${group}`)
            }
          >
            Save {group === "All" ? "all" : "group"} to playlist
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <GroupChips
          groups={groups}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setPage(1);
          }}
        />
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No movies in this group.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {visible.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() =>
                  onPlay({
                    id: `mov-${m.id}`,
                    name: m.name,
                    url: m.url,
                    ...(m.group ? { group: m.group } : {}),
                    ...(m.logo ? { logo: m.logo } : {}),
                  })
                }
                className="group overflow-hidden rounded-lg border border-border bg-surface/40 text-left transition-colors hover:border-primary/50 hover:bg-surface"
              >
                <div className="relative aspect-video w-full">
                  <Poster src={m.logo} name={m.name} />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100">
                    <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      ▶
                    </span>
                  </span>
                </div>
                <div className="px-3 py-2">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  {m.group && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{m.group}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
        <Pager page={page} pages={pages} onPage={setPage} total={filtered.length} />
      </div>
    </CollapsiblePanel>
  );
}

function SeriesPanel({
  series,
  loadEpisodes,
  onPlay,
  onSave,
}: {
  series: SeriesItem[];
  loadEpisodes: (s: SeriesItem) => Promise<SeriesItem>;
  onPlay: (c: Channel) => void;
  onSave: (channels: Channel[], defaultName: string) => void;
}) {
  const [group, setGroup] = useState("All");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({});
  const [localSeries, setLocalSeries] = useState<SeriesItem[]>(series);

  useEffect(() => {
    setLocalSeries(series);
  }, [series]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const s of localSeries) set.add(s.group ?? "Ungrouped");
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [localSeries]);

  const filtered = useMemo(
    () => localSeries.filter((s) => group === "All" || (s.group ?? "Ungrouped") === group),
    [localSeries, group],
  );

  const pages = Math.max(1, Math.ceil(filtered.length / SERIES_PER_PAGE));
  const visible = filtered.slice((page - 1) * SERIES_PER_PAGE, page * SERIES_PER_PAGE);

  async function toggleS(id: string) {
    if (expanded[id]) {
      setExpanded((prev) => ({ ...prev, [id]: false }));
      return;
    }
    const s = localSeries.find((x) => x.id === id);
    if (!s) return;
    if (s.seasons.length === 0) {
      setLoadingIds((prev) => ({ ...prev, [id]: true }));
      const updated = await loadEpisodes(s);
      if (updated.seasons.length > 0) {
        setLocalSeries((prev) => prev.map((x) => (x.id === id ? updated : x)));
      }
      setLoadingIds((prev) => ({ ...prev, [id]: false }));
    }
    setExpanded((prev) => ({ ...prev, [id]: true }));
  }

  return (
    <CollapsiblePanel title="Series" subtitle={`${localSeries.length} available in this login`}>
      <div className="space-y-4">
        <GroupChips
          groups={groups}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setPage(1);
          }}
        />
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No series in this group.</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((s) => {
              const episodes: Channel[] = s.seasons.flatMap((season) =>
                season.episodes.map((ep) => ({
                  id: `ser-${s.id}-ep-${ep.id}`,
                  name: ep.name,
                  url: ep.url,
                  kind: "series",
                  series: s.name,
                  season: season.season,
                  ...(s.group ? { group: s.group } : {}),
                  ...(ep.logo ? { logo: ep.logo } : {}),
                })),
              );
              return (
                <li
                  key={s.id}
                  className="overflow-hidden rounded-lg border border-border bg-surface/40"
                >
                  <div className="flex items-center gap-3 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => void toggleS(s.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:bg-secondary/40"
                    >
                      <div className="h-12 w-20 shrink-0 overflow-hidden rounded">
                        <Poster src={s.logo} name={s.name} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {s.seasons.length > 0
                            ? `${s.seasons.length} seasons`
                            : (s.group ?? "Series")}
                          {s.seasons.length === 0 && s.group && ` · ${s.group}`}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {loadingIds[s.id] ? "Loading…" : expanded[s.id] ? "▲" : "▶"}
                      </span>
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={episodes.length === 0}
                      onClick={() => onSave(episodes, `Series · ${s.name}`)}
                    >
                      Save
                    </Button>
                  </div>
                  {expanded[s.id] && (
                    <div className="space-y-2 border-t border-border bg-background/40 p-3">
                      {s.seasons.length === 0 ? (
                        <p className="text-center text-xs text-muted-foreground">
                          {loadingIds[s.id] ? "Loading episodes…" : "No episodes available."}
                        </p>
                      ) : (
                        s.seasons.map((seasonObj: SeriesSeason) => (
                          <div key={seasonObj.season}>
                            <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                              {seasonObj.name}
                            </p>
                            <div className="space-y-2">
                              {seasonObj.episodes.map((ep) => (
                                <EpisodeRow key={ep.id} episode={ep} onPlay={onPlay} />
                              ))}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <Pager page={page} pages={pages} onPage={setPage} total={filtered.length} />
      </div>
    </CollapsiblePanel>
  );
}

export function VodSection({
  movies,
  series,
  loadSeriesEpisodes,
  onSave,
}: {
  movies: VodItem[];
  series: SeriesItem[];
  loadSeriesEpisodes: (s: SeriesItem) => Promise<SeriesItem>;
  onSave: (channels: Channel[], defaultName: string) => void;
}) {
  const [playing, setPlaying] = useState<Channel | null>(null);
  const [playerKey, setPlayerKey] = useState(0);
  const playerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (playing) playerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [playing]);

  if (movies.length === 0 && series.length === 0) return null;

  const play = (c: Channel) => {
    setPlayerKey((k) => k + 1);
    setPlaying(c);
  };

  return (
    <div className="space-y-5">
      {movies.length > 0 && <MoviesPanel movies={movies} onPlay={play} onSave={onSave} />}
      {series.length > 0 && (
        <SeriesPanel
          series={series}
          loadEpisodes={loadSeriesEpisodes}
          onPlay={play}
          onSave={onSave}
        />
      )}
      {playing && (
        <div id="vod-player" ref={playerRef}>
          <ChannelPlayer key={playerKey} channel={playing} onClose={() => setPlaying(null)} />
        </div>
      )}
    </div>
  );
}
