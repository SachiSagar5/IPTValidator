import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Copy,
  FileUp,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Search,
  ShieldCheck,
  TextCursorInput,
  XCircle,
} from "lucide-react";

import { Badge, Button, Input, Panel } from "@/components/ui/primitives";
import { PENDING_XTREAM_KEY, parseAccountsFile, type AccountEntry } from "@/lib/accounts";
import { checkXtreamAccount } from "@/lib/panel.functions";

export const Route = createFileRoute("/accounts")({
  head: () => ({
    meta: [
      { title: "Import accounts — StreamCheck" },
      {
        name: "description",
        content:
          "Upload an Xtream accounts file, filter active lines, and load them into the validator.",
      },
    ],
  }),
  component: AccountsPage,
});

function statusTone(status: string): "success" | "danger" | "warning" | "muted" {
  const s = status.toLowerCase();
  if (s === "active") return "success";
  if (s === "expired" || s === "dead" || s === "banned" || s === "disabled") return "danger";
  if (s === "trial" || s === "limited" || s === "suspended") return "warning";
  return "muted";
}

const PAGE_SIZE = 10;

type Validation = { state: "idle" | "checking" | "ok" | "fail"; detail: string };

function keyOf(a: AccountEntry): string {
  return `${a.server}|${a.username}`;
}

function AccountsPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const checkAccount = useServerFn(checkXtreamAccount);
  const [entries, setEntries] = useState<AccountEntry[]>([]);
  const [fileName, setFileName] = useState("");
  const [paste, setPaste] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [validations, setValidations] = useState<Record<string, Validation>>({});
  const [validatingAll, setValidatingAll] = useState(false);
  const [onlyWorking, setOnlyWorking] = useState(false);

  const statuses = useMemo(
    () => ["All", ...[...new Set(entries.map((e) => e.status || "Unknown"))]],
    [entries],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      const s = e.status || "Unknown";
      if (statusFilter !== "All" && s !== statusFilter) return false;
      if (onlyWorking && validations[keyOf(e)]?.state !== "ok") return false;
      if (q && !`${e.username} ${e.server} ${e.password}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, statusFilter, search, onlyWorking, validations]);

  const filteredOutByCheck =
    onlyWorking && entries.filter((e) => validations[keyOf(e)]?.state !== "ok").length;

  const workingCount = entries.filter((e) => validations[keyOf(e)]?.state === "ok").length;
  const failedCount = entries.filter((e) => validations[keyOf(e)]?.state === "fail").length;

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const activeCount = entries.filter((e) => (e.status || "").toLowerCase() === "active").length;

  useEffect(() => {
    setPage(1);
  }, [statusFilter, search, onlyWorking, entries]);

  function ingest(text: string, label: string) {
    const parsed = parseAccountsFile(text);
    setEntries(parsed);
    setFileName(label);
    setValidations({});
    setPage(1);
    setOnlyWorking(false);
    if (parsed.length === 0) setPaste("");
  }

  function handleFile(file: File) {
    void file.text().then((text) => ingest(text, file.name));
  }

  function handlePaste() {
    ingest(paste, "Pasted text");
  }

  async function validateOne(a: AccountEntry) {
    const key = keyOf(a);
    setValidations((prev) => ({ ...prev, [key]: { state: "checking", detail: "Checking…" } }));
    try {
      const res = await checkAccount({
        data: { server: a.server, username: a.username, password: a.password },
      });
      setValidations((prev) => ({
        ...prev,
        [key]: { state: res.ok ? "ok" : "fail", detail: res.detail },
      }));
    } catch (e) {
      setValidations((prev) => ({
        ...prev,
        [key]: {
          state: "fail",
          detail: e instanceof Error ? e.message : "Could not validate this account.",
        },
      }));
    }
  }

  async function validateAll() {
    setValidatingAll(true);
    setOnlyWorking(true);
    for (const a of entries) {
      const key = keyOf(a);
      setValidations((prev) => ({ ...prev, [key]: { state: "checking", detail: "Checking…" } }));
      try {
        const res = await checkAccount({
          data: { server: a.server, username: a.username, password: a.password },
        });
        setValidations((prev) => ({
          ...prev,
          [key]: { state: res.ok ? "ok" : "fail", detail: res.detail },
        }));
      } catch (e) {
        setValidations((prev) => ({
          ...prev,
          [key]: {
            state: "fail",
            detail: e instanceof Error ? e.message : "Could not validate this account.",
          },
        }));
      }
    }
    setValidatingAll(false);
  }

  function loadAccount(a: AccountEntry) {
    try {
      sessionStorage.setItem(
        PENDING_XTREAM_KEY,
        JSON.stringify({ server: a.server, username: a.username, password: a.password }),
      );
    } catch {
      // private mode — the main page will not be able to read it either
    }
    void router.navigate({ to: "/" });
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard blocked — ignore
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <header className="rise-in mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to workspace
          </Link>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Import{" "}
            <span className="bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent">
              accounts
            </span>
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">
            Upload an Xtream account list, filter to active lines, then load the credentials into
            the validator workspace.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => setEntries([])}
        >
          Clear list
        </Button>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-5">
          <Panel
            title="Accounts"
            subtitle={`${entries.length} accounts loaded · ${workingCount} working · ${failedCount} failed`}
          >
            {entries.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary">
                  <FileUp className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-medium">No accounts loaded</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Upload a file or paste the account list above.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search username, host, password"
                      className="w-64 pl-9"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="rounded-lg border border-input bg-background/60 px-3 py-2 text-sm text-foreground focus:border-ring focus:ring-2 focus:ring-ring/40 focus:outline-none"
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-muted-foreground">
                    {visible.length} shown
                    {typeof filteredOutByCheck === "number" && filteredOutByCheck > 0
                      ? ` · ${filteredOutByCheck} hidden by filter`
                      : ""}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={onlyWorking}
                      onChange={(e) => setOnlyWorking(e.target.checked)}
                      className="size-4 accent-[oklch(0.86_0.19_124)]"
                    />
                    Show only working accounts
                  </label>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={entries.length === 0 || validatingAll}
                    onClick={() => void validateAll()}
                  >
                    {validatingAll ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="size-3.5" />
                    )}
                    {validatingAll ? "Validating…" : `Validate all (${entries.length})`}
                  </Button>
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[860px] text-left text-sm">
                    <thead className="bg-surface/90 text-[11px] tracking-[0.08em] text-muted-foreground uppercase backdrop-blur">
                      <tr>
                        <th className="px-3 py-2.5 font-medium" />
                        <th className="px-3 py-2.5 font-medium">URL</th>
                        <th className="px-3 py-2.5 font-medium">Username</th>
                        <th className="px-3 py-2.5 font-medium">Password</th>
                        <th className="px-3 py-2.5 font-medium">Status</th>
                        <th className="px-3 py-2.5 font-medium">Max / Act</th>
                        <th className="px-3 py-2.5 font-medium">Verified</th>
                        <th className="px-3 py-2.5 text-right font-medium">Load</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pageRows.map((a) => {
                        const v = validations[keyOf(a)];
                        return (
                          <tr
                            key={keyOf(a)}
                            className={`transition-colors hover:bg-secondary/40 ${v?.state === "fail" ? "bg-destructive/5" : v?.state === "ok" ? "bg-success/5" : ""}`}
                          >
                            <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                              {a.nb || "•"}
                            </td>
                            <td className="max-w-[260px] px-3 py-2">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  aria-label="Copy URL"
                                  onClick={() => void copy(a.url)}
                                  className="text-muted-foreground transition-colors hover:text-foreground"
                                >
                                  <Copy className="size-3.5" />
                                </button>
                                <div className="min-w-0">
                                  <p className="truncate font-mono text-xs">{a.server}</p>
                                  <p className="truncate text-[11px] text-muted-foreground">
                                    {copied === a.url ? "Copied!" : a.url.trim()}
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs">{a.username}</td>
                            <td className="px-3 py-2 font-mono text-xs">{a.password}</td>
                            <td className="px-3 py-2">
                              <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                            </td>
                            <td className="px-3 py-2 text-[11px] text-muted-foreground">
                              {a.maxconn} / {a.actconn}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap items-center justify-end gap-2">
                                {v?.state === "checking" ? (
                                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <LoaderCircle className="size-3.5 animate-spin" />
                                    checking…
                                  </span>
                                ) : v?.state === "ok" ? (
                                  <span
                                    className="inline-flex max-w-[150px] items-center gap-1.5 text-xs text-success"
                                    title={v.detail}
                                  >
                                    <CheckCircle2 className="size-3.5 shrink-0" />
                                    <span className="truncate">working</span>
                                  </span>
                                ) : v?.state === "fail" ? (
                                  <span
                                    className="inline-flex max-w-[150px] items-center gap-1.5 text-xs text-destructive"
                                    title={v.detail}
                                  >
                                    <XCircle className="size-3.5 shrink-0" />
                                    <span className="truncate">failed</span>
                                  </span>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={validatingAll}
                                  onClick={() => void validateOne(a)}
                                >
                                  <RefreshCw className="size-3.5" />
                                  Validate
                                </Button>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <Button size="sm" variant="primary" onClick={() => loadAccount(a)}>
                                <LogIn className="size-3.5" />
                                Load
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Page {safePage} of {pages}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={safePage <= 1}
                      onClick={() => setPage(safePage - 1)}
                    >
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={safePage >= pages}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Panel>
        </section>

        <aside className="space-y-5">
          <Panel title="Upload file" subtitle="Parsed from the pasted or uploaded account list.">
            <div className="space-y-3">
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.csv,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileRef.current?.click();
                  }
                }}
                className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center transition-colors hover:border-primary/50"
              >
                <FileUp className="size-6 text-primary" />
                <p className="text-sm font-medium">{fileName || "Choose a .txt file"}</p>
                <p className="text-xs text-muted-foreground">
                  Entries split on the "NB : n" marker; Active, Dead, Expired lines all kept.
                </p>
              </div>
            </div>
          </Panel>

          <Panel title="Paste account list" subtitle="Same format as the file upload.">
            <div className="space-y-3">
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={10}
                placeholder={
                  "NB : 1\n🔗 http://panel.example.com:8080/get.php?username=…&password=…&type=m3u_plus\n🚦 STATUS : Active\n👤 USERNAME : …\n🔑 PASSWORD : …"
                }
                className="w-full resize-y rounded-lg border border-input bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/40 focus:outline-none"
              />
              <Button
                variant="secondary"
                className="w-full"
                disabled={!paste.trim()}
                onClick={handlePaste}
              >
                <TextCursorInput className="size-4" />
                Parse pasted text
              </Button>
            </div>
          </Panel>
        </aside>
      </div>
    </main>
  );
}
