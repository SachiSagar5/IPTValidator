import { useEffect, useRef, useState } from "react";

import { Badge, Button } from "@/components/ui/primitives";
import type { Channel } from "@/lib/m3u";

type Engine = "hls" | "dash" | "mpegts" | "native";

const ENGINE_ORDER: Engine[] = ["hls", "dash", "mpegts", "native"];

function proxyUrl(url: string) {
  return `/api/public/stream?url=${encodeURIComponent(url)}`;
}

function pickEngine(url: string): Engine {
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (path.endsWith(".mpd") || path.includes("/dash")) return "dash";
  if (path.endsWith(".m3u8") || path.includes("/hls")) return "hls";
  if (path.endsWith(".ts") || path.endsWith(".flv")) return "mpegts";
  if (/\.(mp4|webm|ogg|ogv|m4v|mov|mp3|aac|m4a)$/.test(path)) return "native";
  return "hls";
}

/** Plays HLS, DASH, MPEG-TS/FLV and progressive files, falling back through engines on failure. */
export function ChannelPlayer({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [engine, setEngine] = useState<Engine>(() => pickEngine(channel.url));
  const [direct, setDirect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setEngine(pickEngine(channel.url));
    setDirect(false);
    setError(null);
    setStatus("Connecting…");
    setAttempt(0);
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
            const hls = new Hls({ lowLatencyMode: true, enableWorker: true, maxBufferLength: 20 });
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
              { type, isLive: true, url: src },
              { enableWorker: true, liveBufferLatencyChasing: true },
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

        video.src = src;
        const onErr = () => fallback("The channel did not return a playable stream.");
        video.addEventListener("error", onErr, { once: true });
        destroy = () => video.removeEventListener("error", onErr);
        void video.play().catch(() => setStatus("Press play to start."));
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
  }, [channel.url, engine, direct, attempt]);

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border bg-black/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface/70 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{channel.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{channel.url}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">{engine === "native" ? "built-in" : engine}</Badge>
          {direct && <Badge>direct</Badge>}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              setStatus("Reconnecting…");
              setDirect(false);
              setEngine(pickEngine(channel.url));
              setAttempt((a) => a + 1);
            }}
          >
            Reload
          </Button>
          <Button size="sm" variant="danger" onClick={onClose}>
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
          className="h-full w-full"
        />
        {(status || error) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center">
            <span
              className={`rounded-full px-3 py-1 text-xs ${
                error ? "bg-destructive/80 text-destructive-foreground" : "bg-black/70 text-white"
              }`}
            >
              {error ?? status}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
