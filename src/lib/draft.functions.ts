import { createServerFn } from "@tanstack/react-start";

import { listDraftEntries, removeDraft, upsertDraft, type DbDraft } from "./db";

export type Draft = DbDraft;

export const listDrafts = createServerFn({ method: "GET" }).handler(async () => {
  return listDraftEntries();
});

export const saveDraft = createServerFn({ method: "POST" })
  .inputValidator((data: { id?: string; name: string; content: string }) => {
    if (!data || typeof data.content !== "string" || data.content.trim().length === 0) {
      throw new Error("Draft content is required.");
    }
    return {
      ...(typeof data.id === "string" && data.id ? { id: data.id } : {}),
      name: typeof data.name === "string" ? data.name : "",
      content: data.content,
    };
  })
  .handler(async ({ data }) => upsertDraft(data));

export const deleteDraft = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => {
    if (!data || typeof data.id !== "string") throw new Error("A draft id is required.");
    return { id: data.id };
  })
  .handler(async ({ data }) => removeDraft(data.id));
