"use client";

import { useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };
type Grounding = "bundle" | "diff";

const NOTE: Record<Grounding, string> = {
  bundle: "Answers come from the code and docs this guide shipped with. Anyone with the link can ask.",
  diff: "Answers come from the diff and tour. Anyone with the link can ask.",
};

// Public Q&A about a PR guide: message list, send box, one call per question
// carrying the last six turns as history. Grounding (bundle vs diff) sets the
// note and is reconciled from the first answer if the server reports otherwise.
export default function AskPanel({ spoolId, grounding }: { spoolId: string; grounding?: Grounding }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState<Grounding>(grounding ?? "diff");
  const listRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    const question = input.trim();
    if (!question || pending) return;
    setError("");
    const history = messages.slice(-6);
    const next = [...messages, { role: "user" as const, content: question }];
    setMessages(next);
    setInput("");
    setPending(true);
    try {
      const res = await fetch(`/api/spools/${spoolId}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "could not answer that");
      if (data.grounding === "bundle" || data.grounding === "diff") setNote(data.grounding);
      setMessages([...next, { role: "assistant", content: data.answer || "" }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  };

  return (
    <div className="wv-ask">
      <div className="section-label">Ask about this PR</div>
      <div className="wv-ask-note">{NOTE[note]}</div>

      {messages.length > 0 && (
        <div className="wv-ask-list" ref={listRef}>
          {messages.map((m, i) => (
            <div key={i} className={`wv-ask-msg wv-ask-${m.role}`}>
              {m.content}
            </div>
          ))}
          {pending && (
            <div className="wv-ask-msg wv-ask-assistant wv-ask-dots">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}

      <div className="wv-ask-input">
        <textarea
          className="wv-ask-textarea"
          placeholder="Ask what this PR changes, or why…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        <button className="wv-ask-btn" onClick={send} disabled={pending || !input.trim()}>
          {pending ? "…" : "Ask"}
        </button>
      </div>

      {error && <div className="wv-ask-error">{error}</div>}
    </div>
  );
}
