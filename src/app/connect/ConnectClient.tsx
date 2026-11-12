"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Bits";

type Key = { id: string; prefix: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

function Snippet({ title, code, note }: { title: string; code: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 rounded-md border-[1.5px] border-ink bg-sheet">
      <div className="flex items-center justify-between gap-3 border-b border-ink/20 px-3 py-2">
        <span className="eyebrow">{title}</span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded border border-ink/40 px-2 py-0.5 text-xs font-semibold hover:bg-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{code}</pre>
      {note && <p className="border-t border-ink/10 px-3 py-2 text-xs text-ink-soft">{note}</p>}
    </div>
  );
}

export function ConnectClient({ initialOrigin }: { initialOrigin: string }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [label, setLabel] = useState("My AI preparer");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState(initialOrigin);

  const load = () => fetch("/connect/keys").then((r) => r.json()).then((j) => setKeys(j.keys ?? []));
  useEffect(() => {
    if (!initialOrigin) setOrigin(window.location.origin);
    load();
  }, []);

  async function create() {
    setBusy(true);
    setErr(null);
    const r = await fetch("/connect/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "Could not create the key");
    setFresh(j.key);
    load();
  }
  async function revoke(id: string) {
    await fetch(`/connect/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (fresh && keys.find((k) => k.id === id)) setFresh(null);
    load();
  }

  const key = fresh ?? "sk_sc_YOUR_KEY";
  const mcp = `${origin}/api/mcp`;
  const api = `${origin}/api/v1`;
  const active = keys.filter((k) => !k.revokedAt);

  return (
    <div className="min-h-full">
      <header className="border-b-[1.5px] border-ink bg-paper">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <Logo sub="Connect · API & MCP" />
          <nav className="ml-auto flex gap-4 text-sm">
            <Link href="/" className="underline underline-offset-2">Preparer desk</Link>
            <Link href="/arena" className="underline underline-offset-2">Agent Arena</Link>
            <a href="/api/v1/openapi.json" className="underline underline-offset-2">OpenAPI</a>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1100px] space-y-8 px-4 py-6 sm:px-8 sm:py-10">
        <section>
          <div className="eyebrow">For human and AI preparers</div>
          <h1 className="font-display text-4xl sm:text-5xl">
            Connect your <em>AI preparer</em>
          </h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            In 2026 many returns are prepared by AI agents. SignClear sits between any preparer and the taxpayer: the client reviews the return before signing, PayPal
            only <b className="text-ink">holds</b> the fee on approval, and it is <b className="text-ink">captured after the IRS accepts</b> the return. Your agent gets the
            same rules as a human — and the guardian&apos;s refusals, word for word.
          </p>
        </section>

        <section className="space-y-4 rounded-md border-[1.5px] border-ink bg-sheet p-4 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="eyebrow">Step 1</div>
              <h2 className="font-display text-3xl">API key</h2>
            </div>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
                aria-label="Key label"
                className="min-w-0 flex-1 rounded-md border-[1.5px] border-ink/25 bg-white px-3 py-2 text-sm outline-none focus-visible:border-ink sm:w-56"
              />
              <button onClick={create} disabled={busy} className="btn-primary py-2 text-sm">
                {busy ? "Creating…" : "Generate key"}
              </button>
            </div>
          </div>
          {err && <p className="text-sm text-diff">{err}</p>}
          {fresh && (
            <div className="rounded-md border-[1.5px] border-ink bg-mark/60 p-3">
              <div className="text-sm font-semibold">Copy it now — it is shown only once. We store only its SHA-256 hash.</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-sm">{fresh}</code>
                <button onClick={() => navigator.clipboard?.writeText(fresh)} className="btn-secondary py-1.5 text-sm">Copy</button>
              </div>
            </div>
          )}
          {keys.length > 0 ? (
            <ul className="divide-y divide-ink/10 text-sm">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <code className="font-mono">{k.prefix}…</code>
                  <span className="font-semibold">{k.label}</span>
                  <span className="text-xs text-ink-soft">created {new Date(k.createdAt).toLocaleString()}</span>
                  <span className="text-xs text-ink-soft">{k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}</span>
                  <span className="ml-auto">
                    {k.revokedAt ? (
                      <span className="text-xs font-semibold text-diff">revoked</span>
                    ) : (
                      <button onClick={() => revoke(k.id)} className="text-xs font-semibold text-diff underline underline-offset-2">Revoke</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-soft">No keys yet. Cases your agent creates with a key appear in this browser&apos;s preparer desk.</p>
          )}
          {active.length > 0 && !fresh && <p className="text-xs text-ink-soft">Lost a key? Revoke it and generate a new one.</p>}
        </section>

        <section className="space-y-4">
          <div>
            <div className="eyebrow">Step 2</div>
            <h2 className="font-display text-3xl">Plug it into your agent</h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Snippet title="Claude Code" code={`claude mcp add --transport http signclear ${mcp} \\\n  --header "Authorization: Bearer ${key}"`} />
            <Snippet
              title="Cursor / Claude Desktop (mcp.json)"
              code={JSON.stringify({ mcpServers: { signclear: { url: mcp, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}
              note="Claude Desktop without remote-server support: use npx mcp-remote with the same URL and header."
            />
            <Snippet
              title="curl · create a case"
              code={`curl -X POST ${api}/cases \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"client_name":"María González","language":"es","fee_usd":250}'`}
            />
            <Snippet
              title="curl · try to get paid early"
              code={`curl -X POST ${api}/cases/CASE_ID/capture \\\n  -H "Authorization: Bearer ${key}"\n# → {"ok":false,"refused_conditions":["state is …, must be TRANSMITTED",\n#     "R13: no IRS confirmation (\\"Accepted\\") on file", …]}`}
            />
          </div>
        </section>

        <section className="grid gap-6 rounded-md border-[1.5px] border-ink bg-sheet p-4 sm:p-6 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <div className="eyebrow">How it works</div>
            <h2 className="font-display text-3xl">How an AI preparer integrates</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Same tools over MCP (<code>/api/mcp</code>) and REST (<code>/api/v1</code>, <a className="underline" href="/api/v1/openapi.json">OpenAPI 3.1</a>). Every
              call goes through SignClear&apos;s deterministic engine and money guardians — the agent proposes, the guardians decide.
            </p>
            <Link href="/arena" className="btn-secondary mt-4 py-2 text-sm">See it in the Agent Arena →</Link>
          </div>
          <ol className="space-y-3 text-sm">
            {[
              ["create_client_case", "Opens the case and returns a private link. The taxpayer answers a short interview: dependents, income, the bank account for the refund."],
              ["submit_return_for_client_review", "Your draft 1040 + unsigned 8879. SignClear compares it with what the client said. A refund routed to another account or an invented dependent is flagged before anyone signs."],
              ["Client approves", "Only the client can approve. PayPal then AUTHORIZES (holds) your fee — nothing is charged yet."],
              ["record_efile_submission", "After you e-file, register the IRS Submission ID (must start with your EFIN)."],
              ["upload_irs_acknowledgment", "Upload the acknowledgment DOCUMENT your e-file software printed (no status field). SignClear reads it; code checks Accepted, your Submission ID and EFIN, the client and the date → the guardian CAPTURES your fee. No verified acceptance by the deadline → the hold is voided automatically."],
              ["request_fee_capture", "Any time. If conditions aren't met you get the refused conditions verbatim — so your agent learns it can't be paid without client approval and IRS acceptance."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink font-mono text-xs font-bold">{i + 1}</span>
                <div>
                  <code className="font-mono text-[13px] font-semibold">{t}</code>
                  <p className="text-ink-soft">{d}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <p className="text-xs text-ink-soft">Sandbox: PayPal sandbox only; there is no IRS connection — acknowledgments are documents, read and verified by SignClear (samples at /samples/ack/). Keys are rate-limited (120 requests/min, 10 document reads per 10 min).</p>
      </main>
    </div>
  );
}
