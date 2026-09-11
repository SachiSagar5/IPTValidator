import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, RefreshCw, Volume2, X } from "lucide-react";

import { Badge, Button, Spinner } from "@/components/ui/primitives";
import type { Channel } from "@/lib/m3u";

type Engine = "hls" | "dash" | "mpegts" | "native";

const ENGINE_ORDER: Engine[] = ["hls", "dash", "mpegts", "native"];

function proxyUrl(url: string) {
  return `/api/public/stream?url=${encodeURIComponent(url)}`;
}

/** Formats that the browser can play natively without extra libraries. */
const NATIVE_RE =
  /\.(mp4|webm|ogg|ogv|m4v|mov|mkv|avi|wmv|flv|ts|m2ts|mts|vob|3gp|3g2|f4v|mp3|aac|m4a|wav|flac)(\?|$)/i;

/** HLS or DASH playlist extensions. */
const HLS_RE = /\.m3u8(\?|$)/i;
const DASH_RE = /\.mpd(\?|$)/i;

function pickEngine(url: string): Engine {
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (DASH_RE.test(path) || path.includes("/dash")) return "dash";
  if (HLS_RE.test(path) || path.includes("/hls")) return "hls";
  if (path.endsWith(".ts") || path.endsWith(".flv")) return "mpegts";
  if (NATIVE_RE.test(path)) return "native";
  return "hls";
}

/** Plays HLS, DASH, MPEG-TS/FLV, VOD and progressive files, falling back through engines on failure. */
export function ChannelPlayer({
  channel,
  onClose,
  kind,
}: {
  channel: Channel;
  onClose: () => void;
  kind?: "live" | "movie";
}) {
  const isVod = kind === "movie";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [engine, setEngine] = useState<Engine>(() => pickEngine(channel.url));
  const [direct, setDirect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [meta, setMeta] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setEngine(pickEngine(channel.url));
    setDirect(false);
    setError(null);
    setStatus("Connecting…");
    setAttempt(0);
    setReady(false);
    setPlaying(false);
    setBuffering(false);
    setMeta(null);
    tailNudges.current = 0;
  }, [channel.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    const src = direct ? channel.url : proxyUrl(channel.url);

    const fallback = (reason: string) => {
      if (disposed) return;
      const idx = ENGINE_ORDER.indexOf(engine);
      const next = idx >= 0 ? ENGINE_ORDER[idx + 1] : undefined;
      if (next) {
        setStatus(
          `Retrying with ${next === "native" ? "the built-in player" : `a ${next} player`}…`,
        );
        setEngine(next);
      } else if (!direct) {
        setStatus("Trying the channel directly…");
        setDirect(true);
        setEngine(pickEngine(channel.url));
      } else {
        setError(reason);
        setStatus("");
      }
      setAttempt((a) => a + 1);
    };

    (async () => {
      try {
        if (engine === "hls") {
          const Hls = (await import("hls.js")).default;
          if (disposed) return;
          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: !isVod,
              startLevel: -1,
              startPosition: -1,
              // Live: 30 s buffer for lag-free playback; VOD: generous buffer for smooth scrubbing
              backBufferLength: isVod ? -1 : 60,
              maxBufferLength: isVod ? 30 : 30,
              maxMaxBufferLength: isVod ? 60 : 60,
              maxBufferHole: 0.5,
              maxStarvationDelay: isVod ? 4 : 5,
              liveSyncDurationCount: isVod ? 5 : 4,
              liveMaxLatencyDurationCount: isVod ? 10 : 8,
              // Retry / timeout
              manifestLoadingMaxRetry: 3,
              levelLoadingMaxRetry: 3,
              fragLoadingMaxRetry: isVod ? 5 : 3,
              manifestLoadingTimeOut: 10000,
              fragLoadingTimeOut: isVod ? 15000 : 12000,
            });
            destroy = () => hls.destroy();
            hls.on(Hls.Events.ERROR, (_e, data) => {
              if (data.fatal) fallback(data.details || "Stream could not be played.");
            });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              setStatus("");
              void video.play().catch(() => setStatus("Press play to start."));
            });
            hls.loadSource(src);
            hls.attachMedia(video);
            return;
          }
          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = src;
            void video.play().catch(() => setStatus("Press play to start."));
            return;
          }
          fallback("HLS is not supported in this browser.");
          return;
        }

        if (engine === "dash") {
          const dashjs = await import("dashjs");
          if (disposed) return;
          if (typeof window.MediaSource === "undefined") {
            fallback("DASH is not supported in this browser.");
            return;
          }
          const player = dashjs.MediaPlayer().create();
          destroy = () => {
            try {
              player.reset();
            } catch {
              /* already gone */
            }
          };
          player.on(dashjs.MediaPlayer.events.ERROR, () =>
            fallback("DASH stream could not be played."),
          );
          // Live: 30 s buffer for lag-free playback; VOD: auto-buffer
          if (!isVod) {
            player.updateSettings({
              streaming: {
                buffer: { fastSwitchEnabled: true, bufferToKeep: 30 },
                liveCatchup: {
                  enabled: true,
                  maxDrift: 5,
                  playbackRate: { min: 1, max: 1.5 },
                },
              },
            });
          }
          player.initialize(video, src, true);
          setStatus("");
          return;
        }

        if (engine === "mpegts") {
          const mpegts = (await import("mpegts.js")).default;
          if (disposed) return;
          if (mpegts.isSupported()) {
            const type = (channel.url.split("?")[0] ?? "").toLowerCase().endsWith(".flv")
              ? "flv"
              : "mpegts";
            const player = mpegts.createPlayer(
              { type, isLive: !isVod, url: src },
              {
                enableWorker: true,
                // Live: keep a larger latency window so MPEG-TS buffering stays ahead
                liveBufferLatencyChasing: !isVod,
                liveBufferLatencyMaxLatency: isVod ? 0 : 30,
                liveBufferLatencyMinRemain: isVod ? 0 : 3,
                liveSyncMaxLatency: isVod ? 0 : 30,
                liveSyncTargetLatency: isVod ? 0 : 6,
              },
            );
            destroy = () => {
              try {
                player.destroy();
              } catch {
                /* already gone */
              }
            };
            player.on(mpegts.Events.ERROR, () => fallback("Stream could not be played."));
            player.attachMediaElement(video);
            player.load();
            setStatus("");
            void player.play()?.catch?.(() => setStatus("Press play to start."));
            return;
          }
          fallback("This stream type is not supported in this browser.");
          return;
        }

        // Native: MP4, MKV, WebM, MOV, AVI, etc.
        video.src = src;
        // VOD: preload enough to scrub smoothly
        if (isVod) {
          video.preload = "auto";
        }
        const onErr = () => fallback("The channel did not return a playable stream.");
        video.addEventListener("error", onErr, { once: true });
        destroy = () => video.removeEventListener("error", onErr);
        void video
          .play()
          .then(() => setStatus(""))
          .catch(() => setStatus("Press play to start."));
      } catch {
        fallback("Player failed to load.");
      }
    })();

    return () => {
      disposed = true;
      destroy?.();
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* ignore */
      }
    };
  }, [channel.url, engine, direct, attempt, isVod]);

  /**
   * When the playhead is within PRELOAD_LEAD of the end of a VOD, make sure the
   * player is still buffering ahead so the tail download starts well before it
   * is needed — prevents the "stall at the last 10 seconds" lag on slow links.
   */
  const PRELOAD_LEAD = 10;
  const tailNudges = useRef(0);

  const handleTimeUpdate = useCallback(() => {
    if (!isVod) return;
    const video = videoRef.current;
    if (!video || !isFinite(video.duration) || video.duration <= 0) return;
    const remaining = video.duration - video.currentTime;

    // Not close enough to the end yet — normal buffering already handles it.
    if (remaining > PRELOAD_LEAD || remaining <= 0) return;

    // Encourage the browser/native source buffer to grab the tail before it is reached.
    video.preload = "auto";

    // If the buffer has not reached the end and playback is about to starve,
    // nudge the reader to the edge of buffered data (bounded attempts) so the
    // player fetches the tail ahead of time instead of stalling on it.
    const buffered = video.buffered;
    if (buffered.length > 0) {
      const bufferedEnd = buffered.end(buffered.length - 1);
      if (
        bufferedEnd < video.duration - 0.5 &&
        video.readyState < 3 &&
        video.currentTime > 0.5 &&
        tailNudges.current < 5
      ) {
        tailNudges.current += 1;
        video.currentTime = Math.min(video.currentTime + 0.1, bufferedEnd - 0.01);
      }
    }
  }, [isVod]);

  const reload = () => {
    setError(null);
    setStatus("Reconnecting…");
    setReady(false);
    setBuffering(false);
    setDirect(false);
    setEngine(pickEngine(channel.url));
    setAttempt((a) => a + 1);
  };

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-primary/20 bg-black/70 shadow-[0_24px_60px_-30px_oklch(0_0_0/0.9)] backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 bg-gradient-to-r from-surface/90 via-surface/60 to-surface/30 px-4 py-2.5">
        {channel.logo ? (
          <img
            src={channel.logo}
            alt=""
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
            className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-border"
          />
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/25 to-accent/25 text-base font-bold text-primary ring-1 ring-border">
            {channel.name.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold">{channel.name}</p>
            {!isVod && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-destructive">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/70" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-destructive" />
                </span>
                LIVE
              </span>
            )}
            {isVod && (
              <Badge tone="accent" className="shrink-0">
                MOVIE
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{channel.url}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {meta && (
            <span title={`${meta.width} × ${meta.height}`}>
              <Badge tone="muted">
                {meta.height >= 2160
                  ? "4K"
                  : meta.height >= 1080
                    ? "FHD"
                    : meta.height >= 720
                      ? "HD"
                      : `${meta.width}px`}
              </Badge>
            </span>
          )}
          <Badge tone="accent">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent/60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
            </span>
            {engine === "native" ? "built-in" : engine}
          </Badge>
          {direct && <Badge>direct</Badge>}
          <Button size="sm" variant="ghost" onClick={reload}>
            <RefreshCw className="size-3.5" />
            Reload
          </Button>
          <Button size="sm" variant="danger" onClick={onClose}>
            <X className="size-3.5" />
            Close
          </Button>
        </div>
      </div>

      <div className="relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          controls
          autoPlay
          playsInline
          muted={false}
          onTimeUpdate={handleTimeUpdate}
          onLoadedData={() => setReady(true)}
          onPlaying={() => {
            setPlaying(true);
            setBuffering(false);
            setStatus("");
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onWaiting={() => setBuffering(true)}
          onStalled={() => setBuffering(true)}
          onCanPlay={() => setBuffering(false)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth > 0 && v.videoHeight > 0) {
              setMeta({ width: v.videoWidth, height: v.videoHeight });
            }
          }}
          className="h-full w-full"
        />

        {/* Connecting / starting overlay */}
        {!error && status && !ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60">
            <span className="relative flex size-16">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40" />
              <span className="relative inline-flex size-16 items-center justify-center rounded-full border border-primary/30 bg-primary/15 shadow-[0_0_40px_-8px_oklch(0.86_0.19_124/0.6)] backdrop-blur">
                <Spinner className="size-6 text-primary" />
              </span>
            </span>
            <p className="max-w-xs px-4 text-center text-sm font-medium text-white/90">{status}</p>
          </div>
        )}

        {/* Mid-playback buffering overlay */}
        {!error && ready && buffering && playing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span className="flex items-center gap-2.5 rounded-full border border-primary/25 bg-black/75 px-4 py-2 text-sm font-medium text-white backdrop-blur">
              <Spinner className="size-4 text-primary" />
              Buffering…
            </span>
          </div>
        )}

        {/* Error overlay */}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 px-6 text-center">
            <span className="flex size-14 items-center justify-center rounded-full border border-destructive/40 bg-destructive/15">
              <CircleAlert className="size-6 text-destructive" />
            </span>
            <div>
              <p className="text-sm font-semibold text-white">Playback unavailable</p>
              <p className="mt-1 max-w-sm text-xs text-white/70">{error}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={reload}>
                <RefreshCw className="size-3.5" />
                Try again
              </Button>
              <Button size="sm" variant="danger" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Compact status chip (e.g. "Press play to start.") */}
        {!error && ready && status && !playing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center">
            <span className="flex items-center gap-2 rounded-full border border-border/40 bg-black/70 px-3 py-1 text-xs text-white/80 backdrop-blur">
              <Volume2 className="size-3.5" />
              {status}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
