"use client";

import { useState } from "react";
import styles from "../../../dashboard.module.css";
import {
  type KnowledgeStore,
  type KnowledgeEntry,
  type KnowledgeOp,
  OVERVIEW_MAX,
  SUBSYSTEM_NAME_MAX,
  SUBSYSTEM_TEXT_MAX,
  TERM_MAX,
  TERM_TEXT_MAX,
  RECORDING_TOPIC_MAX,
  RECORDING_TEXT_MAX,
} from "../../../../../lib/knowledgeOps";

type KeyedId = "subsystems" | "vocabulary" | "recording";

// One open editor at a time; drafts live in shared state alongside it.
type EditTarget =
  | { kind: "overview" }
  | { kind: "entry"; section: KeyedId; key: string }
  | { kind: "add"; section: KeyedId };

type KeyedConfig = {
  id: KeyedId;
  title: string;
  singular: string;
  keyLabel: string;
  keyMax: number;
  textMax: number;
  entries: Record<string, KnowledgeEntry>;
  setOp: (key: string, text: string) => KnowledgeOp;
  removeOp: (key: string) => KnowledgeOp;
};

function chipDate(d: string): string {
  if (!d) return "";
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Provenance chip: pr:0 is the manual-edit sentinel written by this dashboard.
function provChip(pr: number, date: string): string {
  const d = chipDate(date);
  const label = pr === 0 ? "edited" : `PR #${pr}`;
  return d ? `${label} · ${d}` : label;
}

export function KnowledgeManager({
  owner,
  repo,
  initial,
}: {
  owner: string;
  repo: string;
  initial: KnowledgeStore;
}) {
  const [store, setStore] = useState<KnowledgeStore>(initial);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftText, setDraftText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cancel() {
    setEditing(null);
    setError(null);
    setDraftKey("");
    setDraftText("");
  }

  // Every mutation posts one op batch; on success we replace state with the
  // server's store so decision indexes and provenance stay authoritative.
  async function mutate(ops: KnowledgeOp[]): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, repo, ops }),
      });
      const data = (await res.json().catch(() => null)) as
        | { knowledge?: KnowledgeStore; error?: string }
        | null;
      if (!res.ok || !data?.knowledge) {
        setError(data?.error || "Could not save. Please try again.");
        return false;
      }
      setStore(data.knowledge);
      return true;
    } catch {
      setError("Network error. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const keyed: KeyedConfig[] = [
    {
      id: "subsystems",
      title: "Subsystems",
      singular: "subsystem",
      keyLabel: "name",
      keyMax: SUBSYSTEM_NAME_MAX,
      textMax: SUBSYSTEM_TEXT_MAX,
      entries: store.subsystems,
      setOp: (name, text) => ({ op: "set_subsystem", name, text }),
      removeOp: (name) => ({ op: "remove_subsystem", name }),
    },
    {
      id: "vocabulary",
      title: "Vocabulary",
      singular: "term",
      keyLabel: "term",
      keyMax: TERM_MAX,
      textMax: TERM_TEXT_MAX,
      entries: store.vocabulary,
      setOp: (term, text) => ({ op: "set_term", term, text }),
      removeOp: (term) => ({ op: "remove_term", term }),
    },
    {
      id: "recording",
      title: "Recording",
      singular: "topic",
      keyLabel: "topic",
      keyMax: RECORDING_TOPIC_MAX,
      textMax: RECORDING_TEXT_MAX,
      entries: store.recording,
      setOp: (topic, text) => ({ op: "set_recording", topic, text }),
      removeOp: (topic) => ({ op: "remove_recording", topic }),
    },
  ];

  // Shared editor body (add reuses it with a key input). onSave closes on success.
  function editor(opts: { withKey: boolean; keyMax?: number; keyLabel?: string; textMax: number; onSave: () => void }) {
    const canSave = opts.withKey ? !!draftKey.trim() && !!draftText.trim() : !!draftText.trim();
    return (
      <div className={styles.kEditor}>
        {opts.withKey && (
          <input
            className={styles.kInput}
            placeholder={opts.keyLabel}
            value={draftKey}
            maxLength={opts.keyMax}
            disabled={busy}
            onChange={(e) => setDraftKey(e.target.value)}
          />
        )}
        <textarea
          className={styles.kTextarea}
          value={draftText}
          maxLength={opts.textMax}
          disabled={busy}
          onChange={(e) => setDraftText(e.target.value)}
        />
        <div className={styles.kEditorActions}>
          <button className={styles.ghost} disabled={busy || !canSave} onClick={opts.onSave}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className={styles.act} disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const overview = store.overview;
  const editingOverview = editing?.kind === "overview";

  return (
    <div>
      {error && <div className={styles.kError}>{error}</div>}

      {/* Overview: edit only (set_overview), no delete. */}
      <section className={styles.kSection}>
        <div className={styles.kSectionHead}>
          <span className={styles.kSectionTitle}>Overview</span>
          {!editingOverview && (
            <button
              className={styles.act}
              disabled={busy}
              onClick={() => {
                setEditing({ kind: "overview" });
                setDraftText(overview?.text ?? "");
                setError(null);
              }}
            >
              {overview ? "Edit" : "Add"}
            </button>
          )}
        </div>
        {editingOverview ? (
          <div className={styles.kEntry}>
            {editor({
              withKey: false,
              textMax: OVERVIEW_MAX,
              onSave: async () => {
                if (await mutate([{ op: "set_overview", text: draftText }])) cancel();
              },
            })}
          </div>
        ) : overview ? (
          <div className={styles.kEntry}>
            <div className={styles.kEntryHead}>
              <span className={styles.kSpacer} />
              <span className={styles.kChip}>{provChip(overview.pr, overview.updatedAt)}</span>
            </div>
            <div className={styles.kText}>{overview.text}</div>
          </div>
        ) : (
          <div className={styles.kEmpty}>No overview yet.</div>
        )}
      </section>

      {/* Keyed sections: edit + delete per entry, plus an add affordance. */}
      {keyed.map((cfg) => {
        const keys = Object.keys(cfg.entries);
        const adding = editing?.kind === "add" && editing.section === cfg.id;
        return (
          <section className={styles.kSection} key={cfg.id}>
            <div className={styles.kSectionHead}>
              <span className={styles.kSectionTitle}>{cfg.title}</span>
              {!adding && (
                <button
                  className={styles.act}
                  disabled={busy}
                  onClick={() => {
                    setEditing({ kind: "add", section: cfg.id });
                    setDraftKey("");
                    setDraftText("");
                    setError(null);
                  }}
                >
                  Add {cfg.singular}
                </button>
              )}
            </div>

            {adding && (
              <div className={styles.kEntry}>
                {editor({
                  withKey: true,
                  keyMax: cfg.keyMax,
                  keyLabel: cfg.keyLabel,
                  textMax: cfg.textMax,
                  onSave: async () => {
                    if (await mutate([cfg.setOp(draftKey.trim(), draftText)])) cancel();
                  },
                })}
              </div>
            )}

            {keys.length === 0 && !adding ? (
              <div className={styles.kEmpty}>Nothing yet.</div>
            ) : (
              <div className={styles.kList}>
                {keys.map((key) => {
                  const entry = cfg.entries[key];
                  const isEditing =
                    editing?.kind === "entry" && editing.section === cfg.id && editing.key === key;
                  return (
                    <div className={styles.kEntry} key={key}>
                      {isEditing ? (
                        <>
                          <div className={styles.kEntryHead}>
                            <span className={styles.kKey}>{key}</span>
                          </div>
                          {editor({
                            withKey: false,
                            textMax: cfg.textMax,
                            onSave: async () => {
                              if (await mutate([cfg.setOp(key, draftText)])) cancel();
                            },
                          })}
                        </>
                      ) : (
                        <>
                          <div className={styles.kEntryHead}>
                            <span className={styles.kKey}>{key}</span>
                            <span className={styles.kSpacer} />
                            <span className={styles.kChip}>{provChip(entry.pr, entry.updatedAt)}</span>
                            <div className={styles.kActions}>
                              <button
                                className={styles.act}
                                disabled={busy}
                                onClick={() => {
                                  setEditing({ kind: "entry", section: cfg.id, key });
                                  setDraftText(entry.text);
                                  setError(null);
                                }}
                              >
                                Edit
                              </button>
                              <button
                                className={styles.actDanger}
                                disabled={busy}
                                onClick={() => {
                                  if (confirm(`Delete ${cfg.singular} "${key}"?`)) mutate([cfg.removeOp(key)]);
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                          <div className={styles.kText}>{entry.text}</div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      {/* Decisions: the publish ledger. Delete only, indexed against this store. */}
      <section className={styles.kSection}>
        <div className={styles.kSectionHead}>
          <span className={styles.kSectionTitle}>Decisions</span>
        </div>
        {store.decisions.length === 0 ? (
          <div className={styles.kEmpty}>No decisions recorded.</div>
        ) : (
          <div className={styles.kList}>
            {store.decisions.map((d, i) => (
              <div className={styles.kEntry} key={`${i}-${d.what}`}>
                <div className={styles.kDecision}>
                  <div className={styles.kDecisionBody}>
                    <div className={styles.kDecisionWhat}>{d.what}</div>
                    <div className={styles.kDecisionWhy}>{d.why}</div>
                  </div>
                  <span className={styles.kChip}>{provChip(d.pr, d.date)}</span>
                  <button
                    className={styles.actDanger}
                    disabled={busy}
                    onClick={() => {
                      if (confirm("Delete this decision?")) mutate([{ op: "remove_decision", index: i }]);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
