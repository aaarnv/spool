"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "parsing" | "confirm" | "submitting" | "polling" | "done" | "error";
type JobStatus = "queued" | "running" | "done" | "error";

// Owner-only edit panel: chat input → ops confirm card → job poll → cache-busted
// refresh on done. Rendered only for the spool's owner (see page.tsx).
export default function EditPanel({
  spoolId,
  hasSources,
  videoSrc,
}: {
  spoolId: string;
  hasSources: boolean;
  videoSrc: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [instruction, setInstruction] = useState("");
  const [ops, setOps] = useState<unknown[]>([]);
  const [summary, setSummary] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  };

  // Bust the browser cache so the re-rendered final.mp4 (same URL) reloads.
  const refreshVideo = useCallback(() => {
    const v = document.querySelector<HTMLVideoElement>("video");
    if (v) v.src = `${videoSrc}${videoSrc.includes("?") ? "&" : "?"}v=${Date.now()}`;
  }, [videoSrc]);

  const watch = useCallback(() => {
    stopPoll();
    setPhase("polling");
    poll.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/spools/${spoolId}/edit/status`, { cache: "no-store" });
        if (!res.ok) return;
        const { job } = (await res.json()) as { job: { status: JobStatus; error: string | null } | null };
        if (!job) return;
        if (job.status === "done") {
          stopPoll();
          refreshVideo();
          setPhase("done");
          setToast("Edit applied — video updated");
          setTimeout(() => setToast(""), 4000);
        } else if (job.status === "error") {
          stopPoll();
          setError(job.error || "the render failed");
          setPhase("error");
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2500);
  }, [spoolId, refreshVideo]);

  // On mount, surface any in-flight job so a reload keeps tracking it.
  useEffect(() => {
    if (!hasSources) return;
    (async () => {
      try {
        const res = await fetch(`/api/spools/${spoolId}/edit/status`, { cache: "no-store" });
        if (!res.ok) return;
        const { job } = (await res.json()) as { job: { status: JobStatus; error: string | null } | null };
        if (job && (job.status === "queued" || job.status === "running")) watch();
      } catch {
        /* ignore */
      }
    })();
    return stopPoll;
  }, [spoolId, hasSources, watch]);

  if (!hasSources) {
    return (
      <div className="editpanel">
        <div className="section-label">Edit</div>
        <div className="edit-note">Re-publish with the latest CLI to enable editing this spool.</div>
      </div>
    );
  }

  const parse = async () => {
    const text = instruction.trim();
    if (!text) return;
    setError("");
    setPhase("parsing");
    try {
      const res = await fetch(`/api/spools/${spoolId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "could not parse that");
      if (!Array.isArray(data.ops) || data.ops.length === 0) throw new Error("no edits matched that request");
      setOps(data.ops);
      setSummary(Array.isArray(data.summary) ? data.summary : []);
      setPhase("confirm");
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  };

  const confirm = async () => {
    setError("");
    setPhase("submitting");
    try {
      const res = await fetch(`/api/spools/${spoolId}/edit/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops, instruction: instruction.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "could not queue the edit");
      setInstruction("");
      watch();
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  };

  const reset = () => {
    setPhase("idle");
    setError("");
    setOps([]);
    setSummary([]);
  };

  const busy = phase === "parsing" || phase === "submitting";

  return (
    <div className="editpanel">
      <div className="section-label">Edit</div>

      {(phase === "idle" || phase === "parsing" || phase === "error") && (
        <div className="edit-input">
          <textarea
            className="edit-textarea"
            placeholder="Describe an edit — e.g. “remove the second step and retitle it Finishing Lab v2”"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") parse();
            }}
            rows={2}
          />
          <button className="edit-btn" onClick={parse} disabled={busy || !instruction.trim()}>
            {phase === "parsing" ? "Reading…" : "Propose"}
          </button>
        </div>
      )}

      {phase === "confirm" && (
        <div className="edit-card">
          <div className="edit-card-title">Apply these edits?</div>
          <ul className="edit-summary">
            {(summary.length ? summary : ops.map((o) => JSON.stringify(o))).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <div className="edit-actions">
            <button className="edit-btn" onClick={confirm}>
              Confirm & re-render
            </button>
            <button className="edit-btn ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {(phase === "submitting" || phase === "polling") && (
        <div className="edit-status">
          <span className="edit-spinner" />
          {phase === "submitting" ? "Queuing edit…" : "Re-rendering — this can take a minute…"}
        </div>
      )}

      {phase === "done" && (
        <div className="edit-input">
          <div className="edit-note">Latest edit applied. Describe another to keep going.</div>
          <button className="edit-btn ghost" onClick={reset}>
            New edit
          </button>
        </div>
      )}

      {phase === "error" && error && <div className="edit-error">{error}</div>}

      {toast && <div className="edit-toast">{toast}</div>}
    </div>
  );
}
