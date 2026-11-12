"use client";
import { useEffect, useRef, useState } from "react";
import { tr, type CaseView, type Lang } from "./useCase";
import { AGENT_NAME } from "@/lib/brand";
import { ListenButton, MicButton } from "./Bits";

const SUGGEST: Record<Lang, string[]> = {
  es: ["¿Qué es el Schedule C?", "¿Por qué recibo el crédito por trabajo?", "¿A qué cuenta llega mi reembolso?"],
  en: ["What is Schedule C?", "Why do I get the earned income credit?", "Which account gets my refund?"],
  pt: ["O que é o Schedule C?", "Por que recebo o crédito por trabalho?", "Para qual conta vai meu reembolso?"],
};

export function ChatPanel({ v, lang, onSend, onFocus, onSendQuestions }: { v: CaseView; lang: Lang; onSend: (text: string) => Promise<unknown>; onFocus: (row: string) => void; onSendQuestions?: (id: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [showEarlier, setShowEarlier] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [busyUntil, setBusyUntil] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const lastAgent = [...v.chat].reverse().find((m) => m.role === "agent");
    if (lastAgent?.focusRow) onFocus(`${lastAgent.focusRow}~auto`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.chat.length]);
  const waiting = Date.now() < busyUntil && v.chat[v.chat.length - 1]?.role === "client";
  const send = async (t: string) => {
    if (!t.trim()) return;
    setBusyUntil(Date.now() + 30000);
    setText("");
    await onSend(t);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" style={{ maxHeight: 460, minHeight: 260 }}>
        {v.chat.length === 0 && (
          <div className="text-sm text-ink-soft">
            {tr({ es: "Pregúnteme sobre cualquier línea de su declaración. Respondo con lo que dicen sus documentos.", en: "Ask me about any line of your return. I answer from your documents.", pt: "Pergunte sobre qualquer linha da sua declaração. Respondo com base nos seus documentos." }, lang)}
          </div>
        )}
        {v.chat.some((m) => m.stale) && (
          <button onClick={() => setShowEarlier((x) => !x)} className="font-mono text-[11px] uppercase tracking-wider text-ink-soft underline underline-offset-2">
            {showEarlier
              ? tr({ es: "Ocultar la revisión anterior", en: "Hide the earlier review", pt: "Ocultar a revisão anterior" }, lang)
              : tr({ es: `Ver la revisión anterior (${v.chat.filter((m) => m.stale).length})`, en: `Show the earlier review (${v.chat.filter((m) => m.stale).length})`, pt: `Ver a revisão anterior (${v.chat.filter((m) => m.stale).length})` }, lang)}
          </button>
        )}
        {v.chat.filter((m) => showEarlier || !m.stale).map((m) => {
          if (m.text.startsWith("__QUESTIONS__") || m.text.startsWith("__QUESTIONS_SENT__")) {
            const sent = m.text.startsWith("__QUESTIONS_SENT__");
            const qs = JSON.parse(m.text.slice(sent ? 18 : 13)) as string[];
            const stale = !sent && (!!m.stale || !["CLARIFY", "DIFFERENCES", "MATCH"].includes(v.state));
            return (
              <div key={m.id} className={`rounded-md border-[1.5px] border-dashed border-ink/50 bg-paper p-4 text-sm ${stale || (sent && m.stale) ? "opacity-60" : ""}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2 font-semibold text-ink">
                  {tr({ es: `Preguntas para ${v.preparer.name}`, en: `Questions for ${v.preparer.name}`, pt: `Perguntas para ${v.preparer.name}` }, lang)}
                  {m.stale && <StaleTag kind={m.stale} lang={lang} />}
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-ink">
                  {qs.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ol>
                {stale ? (
                  <div className="mt-3 text-xs text-ink-soft">{tr({ es: "Borrador no enviado · ya no hace falta: la situación cambió.", en: "Draft not sent · no longer needed: the situation changed.", pt: "Rascunho não enviado · não é mais necessário: a situação mudou." }, lang)}</div>
                ) : sent ? (
                  <div className="mt-3 font-mono text-xs font-bold uppercase tracking-wider text-ok">✓ {tr({ es: `Enviadas a ${v.preparer.name}`, en: `Sent to ${v.preparer.name}`, pt: `Enviadas para ${v.preparer.name}` }, lang)}</div>
                ) : (
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      disabled={sending === m.id}
                      onClick={async () => {
                        setSending(m.id);
                        await onSendQuestions?.(m.id);
                        setSending(null);
                      }}
                      className="btn-primary py-1.5 text-sm"
                    >
                      {sending === m.id ? "…" : null}
                      {tr({ es: `Enviar a ${v.preparer.name.split(" ")[0]}`, en: `Send to ${v.preparer.name.split(" ")[0]}`, pt: `Enviar para ${v.preparer.name.split(" ")[0]}` }, lang)}
                    </button>
                    <span className="text-xs text-ink-soft">{tr({ es: "Revíselas antes de enviarlas.", en: "Review them before sending.", pt: "Revise antes de enviar." }, lang)}</span>
                  </div>
                )}
              </div>
            );
          }
          if (m.role === "client")
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-md bg-ink px-4 py-2.5 text-sm text-sheet">{m.text}</div>
              </div>
            );
          return (
            <div key={m.id} className={`flex gap-2.5 ${m.stale ? "opacity-55" : ""}`}>
              <Avatar who={m.role === "agent" ? AGENT_NAME[0] : v.preparer.name[0]} agent={m.role === "agent"} />
              <div className={`max-w-[85%] py-1 pl-3 pr-1 leading-snug text-ink ${m.role === "preparer" ? "border-l-[3px] border-ink bg-paper text-[15px]" : `border-l-[3px] ${m.stale ? "border-ink/20" : "border-mark"} bg-sheet font-display text-[17px]`}`}>
                {m.role === "preparer" && <div className="mb-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">{v.preparer.name}</div>}
                {m.stale && <div className="mb-1"><StaleTag kind={m.stale} lang={lang} /></div>}
                {m.text.replace(/\s*\[R\d+[a-z]?\]/g, "")}
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  <ListenButton text={m.text.replace(/\s*\[R\d+[a-z]?\]/g, "")} lang={lang} small />
                  {m.focusRow && (
                    <button onClick={() => onFocus(m.focusRow!)} className="font-sans text-xs font-semibold text-ink underline decoration-mark decoration-4 underline-offset-2">
                      {tr({ es: "Ver en la tabla →", en: "See in the table →", pt: "Ver na tabela →" }, lang)}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {(waiting || (!v.chat.some((m) => m.role === "agent") && v.rows.length > 0 && ["CLARIFY", "DIFFERENCES", "MATCH"].includes(v.state))) && (
          <div className="flex gap-2.5">
            <Avatar who={AGENT_NAME[0]} agent />
            <div className="flex items-center gap-2 border-l-[3px] border-mark px-4 py-3 text-sm text-ink-soft">
              {!waiting && <span>{tr({ es: `${AGENT_NAME} está leyendo su declaración…`, en: `${AGENT_NAME} is reading your return…`, pt: `${AGENT_NAME} está lendo sua declaração…` }, lang)}</span>}
              <span className="inline-flex gap-1">
                <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft" />
                <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft [animation-delay:120ms]" />
                <i className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-soft [animation-delay:240ms]" />
              </span>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {SUGGEST[lang].map((s) => (
          <button key={s} onClick={() => send(s)} className="rounded-md border-[1.5px] border-ink/20 bg-sheet px-3 py-1 text-xs text-ink-soft hover:border-ink hover:text-ink">
            {s}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-2 border-t-[1.5px] border-ink p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={tr({ es: "Escriba su pregunta…", en: "Type your question…", pt: "Digite sua pergunta…" }, lang)}
          className="min-w-0 flex-1 rounded-md border-[1.5px] border-ink/25 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-ink"
        />
        <MicButton lang={lang} onText={(t) => setText((x) => (x ? `${x} ${t}` : t))} />
        <button className="btn-primary px-4 py-2.5 text-sm">{tr({ es: "Enviar", en: "Send", pt: "Enviar" }, lang)}</button>
      </form>
    </div>
  );
}

/** Marks a message from an earlier review so it can't be read as the current situation. */
function StaleTag({ kind, lang }: { kind: "resolved" | "earlier"; lang: Lang }) {
  const l =
    kind === "resolved"
      ? tr({ es: "Resuelto · revisión anterior", en: "Resolved · earlier review", pt: "Resolvido · revisão anterior" }, lang)
      : tr({ es: "Revisión anterior", en: "Earlier review", pt: "Revisão anterior" }, lang);
  return <span className="inline-block rounded-sm border border-ink/40 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ink-soft">{kind === "resolved" ? "✓ " : ""}{l}</span>;
}

export function Avatar({ who, agent }: { who: string; agent?: boolean }) {
  return (
    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border-[1.5px] border-ink font-display text-base ${agent ? "bg-mark text-ink" : "bg-sheet text-ink"}`}>
      {who}
    </span>
  );
}
