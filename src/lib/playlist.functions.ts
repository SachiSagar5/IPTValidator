import { createServerFn } from "@tanstack/react-start";

import type { Channel } from "./m3u";
import { createPlaylist, listAll, removePlaylist, renameEntry, type DbPlaylist } from "./db";

export type SavedPlaylist = DbPlaylist;

export const listPlaylists = createServerFn({ method: "GET" }).handler(async () => {
  return listAll();
});

export const savePlaylist = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      name: string;
      channels: Channel[];
      source?: string;
      provider?: "xtream" | "stalker";
      server?: string;
      username?: string;
      password?: string;
      mac?: string;
    }) => {
      if (!data || !Array.isArray(data.channels) || data.channels.length === 0) {
        throw new Error("A channel list is required.");
      }
      return {
        name: typeof data.name === "string" ? data.name : "",
        channels: data.channels,
        source: typeof data.source === "string" ? data.source : undefined,
        provider:
          data.provider === "xtream" || data.provider === "stalker" ? data.provider : undefined,
        server: typeof data.server === "string" ? data.server : undefined,
        username: typeof data.username === "string" ? data.username : undefined,
        password: typeof data.password === "string" ? data.password : undefined,
        mac: typeof data.mac === "string" ? data.mac : undefined,
      };
    },
  )
  .handler(async ({ data }) =>
    createPlaylist(data.name, data.channels, data.source, {
      ...(data.provider ? { provider: data.provider } : {}),
      ...(data.server ? { server: data.server } : {}),
      ...(data.username ? { username: data.username } : {}),
      ...(data.password ? { password: data.password } : {}),
      ...(data.mac ? { mac: data.mac } : {}),
    }),
  );

export const deletePlaylist = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => {
    if (!data || typeof data.id !== "string") throw new Error("A playlist id is required.");
    return { id: data.id };
  })
  .handler(async ({ data }) => removePlaylist(data.id));

export const renamePlaylist = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; name: string }) => {
    if (!data || typeof data.id !== "string" || typeof data.name !== "string") {
      throw new Error("A playlist id and name are required.");
    }
    return { id: data.id, name: data.name };
  })
  .handler(async ({ data }) => renameEntry(data.id, data.name));
