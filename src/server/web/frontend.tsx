import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";

interface TraceEvent {
  job_uuid: string;
  agent: string;
  kind: string;
  step: string;
  tool: string;
  conclusion: string;
  output_query: string;
  ts: string;
}

interface JobInfo {
  job_uuid: string;
  arxiv_id: string;
  source?: string;
}

interface JobStatus {
  job_uuid: string;
  status: string;
  awaiting_approval: { plan: Record<string, unknown> } | null;
  github_url?: string;
}

interface ByokStatus { configured: boolean; base_url: string; model: string; }

interface PaperRepo {
  arxiv_id: string;
  repo_name: string;
  description: string;
  html_url: string;
  updated_at: string;
  stars: number;
}

interface PaperFile {
  path: string;
  type: "blob" | "tree";
  size: number;
}

interface ImplementationFile {
  path: string;
  content: string;
}

interface Implementation {
  repo_name: string;
  arxiv_id: string;
  html_url: string;
  tree: PaperFile[];
  files: ImplementationFile[];
}

const PHASE_ORDER = ["READ", "RESEARCH", "PLAN", "CODE", "VERIFY", "ORCHESTRATOR", "SYSTEM"];
const PHASE_LABEL: Record<string, string> = {
  READ: "Read", RESEARCH: "Research", PLAN: "Plan", CODE: "Code", VERIFY: "Verify",
  ORCHESTRATOR: "Orchestrator", SYSTEM: "System",
};

function StatusBadge({ status }: { status: string }) {
  const cls = status === "done" ? "done" : status === "failed" ? "failed"
    : status.startsWith("awaiting") ? "awaiting_user_approval" : "running";
  return <span className={`status-badge ${cls}`}>{status}</span>;
}

// ─── Single-server + localStorage sync ───────────────────────────────────────
// The agent-server is the single source of truth (all TUI+web runs go through it).
// Web mirrors server jobs into localStorage so chats survive reloads and are
// shareable across browser tabs (BroadcastChannel). TUI delegates to the server
// when it's available, so every instance sees the same jobs.
function useJobs() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const refresh = useCallback(() => {
    fetch("/api/jobs").then((r) => r.json()).then((d) => {
      const serverJobs: JobInfo[] = d.jobs ?? [];
      setJobs(serverJobs);
      // mirror into localStorage so reloads keep history even if server restarts
      try {
        const local = JSON.parse(localStorage.getItem("polaris.chat.jobs") ?? "[]") as string[];
        const merged = [...new Set([...local, ...serverJobs.map(j=>j.job_uuid)])];
        localStorage.setItem("polaris.chat.jobs", JSON.stringify(merged.slice(-100)));
        // Also broadcast for other tabs
        try { new BroadcastChannel("polaris-jobs").postMessage({ type: "jobs", jobs: serverJobs }); } catch {}
      } catch {}
    }).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  // Poll every 3s so TUI-created jobs appear in web without manual refresh
  useEffect(() => {
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);
  // Cross-tab sync via storage event + BroadcastChannel
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === "polaris.chat.jobs") refresh(); };
    window.addEventListener("storage", onStorage);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("polaris-jobs");
      bc.onmessage = (ev) => { if (ev.data?.type === "jobs") setJobs(ev.data.jobs); };
    } catch {}
    return () => { window.removeEventListener("storage", onStorage); bc?.close(); };
  }, [refresh]);
  return { jobs, refresh };
}

// ─── Pipeline view ──────────────────────────────────────────────────────────────
function PipelineView({ byok, setByok, showSettings, setShowSettings }: {
  byok: ByokStatus | null;
  setByok: (b: ByokStatus)=>void;
  showSettings: boolean;
  setShowSettings: (v: boolean)=>void;
}) {
  const { jobs, refresh } = useJobs();
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [arxivId, setArxivId] = useState("");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [feedback, setFeedback] = useState("");
  const engine: "trueforge" = "trueforge"; // forced TrueForge harness
  const [reuse, setReuse] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<{ kind: string; arxiv_id: string; title: string; pages: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [localChats, setLocalChats] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("polaris.chat.jobs") ?? "[]") as string[]; } catch { return []; }
  });
  const eventSource = useRef<EventSource | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const traceEndRef = useRef<HTMLDivElement | null>(null);

  // Persist local chats + broadcast
  useEffect(() => {
    try {
      localStorage.setItem("polaris.chat.jobs", JSON.stringify(localChats.slice(-100)));
      new BroadcastChannel("polaris-jobs").postMessage({ type: "local", jobs: localChats });
    } catch {}
  }, [localChats]);
  // Persist traces per job (cap 2000)
  useEffect(() => {
    if (activeJob) {
      try { localStorage.setItem(`polaris.chat.${activeJob}`, JSON.stringify(traces.slice(-2_000))); } catch {}
    }
  }, [activeJob, traces]);
  // Auto-scroll traces
  useEffect(() => { traceEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [traces]);

  const selectJob = useCallback((uuid: string) => {
    setActiveJob(uuid);
    try { setTraces(JSON.parse(localStorage.getItem(`polaris.chat.${uuid}`) ?? "[]") as TraceEvent[]); } catch { setTraces([]); }
    setFeedback("");
    if (eventSource.current) eventSource.current.close();
    eventSource.current = new EventSource(`/api/jobs/${uuid}/stream`);
    eventSource.current.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as TraceEvent;
        setTraces((prev) => [...prev, ev]);
      } catch {}
    };
    eventSource.current.onerror = () => {
      // auto-reconnect after 1s
      setTimeout(() => {
        if (eventSource.current?.readyState === EventSource.CLOSED) {
          eventSource.current = new EventSource(`/api/jobs/${uuid}/stream`);
          eventSource.current.onmessage = (e) => setTraces((prev)=> [...prev, JSON.parse(e.data) as TraceEvent]);
        }
      }, 1000);
    };
    const poll = setInterval(() => {
      fetch(`/api/jobs/${uuid}`).then((r) => r.json()).then((d: JobStatus) => {
        setStatus(d);
        if (d.status === "done" || d.status === "failed") clearInterval(poll);
      }).catch(() => {});
    }, 1200);
    // cleanup on unmount handled via close
    return () => clearInterval(poll);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setUploadFile(file);
    setUploadPreview(null);
    setUploading(true);
    const form = new FormData();
    form.append("paper", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: form });
      const d = await r.json();
      if (d.error) { setUploadPreview({ kind: "error", arxiv_id: "", title: d.error, pages: 0 }); }
      else setUploadPreview({ kind: d.kind, arxiv_id: d.arxiv_id, title: d.title, pages: d.pages });
    } catch (e) {
      setUploadPreview({ kind: "error", arxiv_id: "", title: (e as Error).message, pages: 0 });
    }
    setUploading(false);
  }, []);

  const runPaper = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!arxivId.trim() && !uploadFile) return;
    if (!byok?.configured) { setShowSettings(true); return; }
    const form = new FormData();
    if (uploadFile) form.append("paper", uploadFile);
    if (arxivId.trim()) form.append("arxiv_id", arxivId.trim());
    form.append("engine", engine);
    form.append("reuse_if_exists", reuse ? "1" : "0");
    // Show loading hint
    setTraces([]);
    setStatus({ job_uuid: "pending", status: "running", awaiting_approval: null });
    fetch("/api/run", { method: "POST", body: form }).then((r) => r.json()).then((d) => {
      if (d.error) {
        setStatus({ job_uuid: "error", status: "failed", awaiting_approval: null });
        setTraces([{ job_uuid: "error", agent: "SYSTEM", kind: "ERROR", step: "error", tool: "", conclusion: d.error, output_query: "", ts: new Date().toISOString() }]);
        return;
      }
      if (d.job_uuid) {
        refresh();
        setArxivId("");
        setUploadFile(null);
        setUploadPreview(null);
        setLocalChats((previous) => [...new Set([...previous, d.job_uuid])]);
        selectJob(d.job_uuid);
      }
    }).catch((err)=>{
      setStatus({ job_uuid: "error", status: "failed", awaiting_approval: null });
      setTraces([{ job_uuid: "error", agent: "SYSTEM", kind: "ERROR", step: "error", tool: "", conclusion: String(err), output_query: "", ts: new Date().toISOString() }]);
    });
  }, [arxivId, uploadFile, engine, reuse, selectJob, refresh, byok, setShowSettings]);

  const approve = useCallback((approved: boolean) => {
    if (!activeJob) return;
    fetch(`/api/jobs/${activeJob}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved, feedback }),
    }).then(() => { setStatus(null); setFeedback(""); }).catch(()=>{});
  }, [activeJob, feedback]);

  const clearHistory = useCallback(() => {
    if (!confirm("Clear local chat history? Server jobs remain.")) return;
    localStorage.removeItem("polaris.chat.jobs");
    // remove per-job traces
    for (const k of Object.keys(localStorage)) if (k.startsWith("polaris.chat.")) localStorage.removeItem(k);
    setLocalChats([]);
    setActiveJob(null);
    setTraces([]);
    setStatus(null);
  }, []);

  // Merge server jobs + localChats for display (server authoritative, local for offline)
  const displayJobs = useMemo(() => {
    const byId = new Map<string, JobInfo>();
    for (const j of jobs) byId.set(j.job_uuid, j);
    for (const id of localChats) if (!byId.has(id)) byId.set(id, { job_uuid: id, arxiv_id: "" });
    return [...byId.values()].slice(-80).reverse();
  }, [jobs, localChats]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">Polaris<span>AI</span><button className="settings-button" onClick={() => setShowSettings(true)} title="Change LLM provider (BYOK) — one click">⚙</button></div>
        {/* BYOK pill — prominent, one-click to change provider (shared server) */}
        <button className={`byok-state ${byok?.configured ? "ready" : "missing"}`} onClick={() => setShowSettings(true)} title="Click to change LLM provider">
          <span className="byok-dot">{byok?.configured ? "●" : "○"}</span>
          <span className="byok-text">{byok?.configured ? `${byok.model}` : "Add LLM provider"}</span>
          <span className="byok-action">{byok?.configured ? "change" : "setup"}</span>
        </button>
        {!byok?.configured && <div className="byok-hint">Provider not set — add your OpenAI-compatible key to start. Works for both web and TUI (single server).</div>}

        <form className="run-form" onSubmit={runPaper}>
          <input placeholder="arXiv ID (e.g. 2301.12345)" value={arxivId}
            onChange={(e) => setArxivId(e.target.value)} aria-label="arXiv ID" />
          <button className="btn" type="submit" disabled={!arxivId.trim() && !uploadFile} title={byok?.configured ? "Run pipeline" : "Add provider first"}>Run</button>
        </form>

        {/* File upload dropzone */}
        <div
          className={`dropzone ${dragOver ? "drag" : ""} ${uploadFile ? "has-file" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e)=>{ if(e.key==="Enter") fileInput.current?.click(); }}
          aria-label="Upload paper"
        >
          <input ref={fileInput} type="file" accept=".pdf,.md,.markdown,.txt,.tex"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          {uploading ? <span className="dz-text">Extracting text…</span>
            : uploadFile ? <span className="dz-text">📎 {uploadFile.name} <span className="dim">— click to change</span></span>
            : <span className="dz-text">Drop a PDF / .md / .tex here<br /><span className="dim">or click to browse</span></span>}
        </div>
        {uploadPreview && uploadPreview.kind !== "error" && (
          <div className="upload-meta">
            <span className="badge kind">{uploadPreview.kind}</span>
            {uploadPreview.arxiv_id && <span className="badge">arXiv {uploadPreview.arxiv_id}</span>}
            {uploadPreview.pages > 0 && <span className="badge">{uploadPreview.pages}p</span>}
            {uploadPreview.title && <div className="upload-title dim">{uploadPreview.title.slice(0, 80)}</div>}
          </div>
        )}
        {uploadPreview?.kind === "error" && <div className="upload-meta error">{uploadPreview.title}</div>}

        {/* Engine is forced TrueForge — broker for extraction, model does CODE */}
        <div className="run-options">
          <div className="opt-row" style={{justifyContent:"space-between"}}>
            <span className="opt-label">Harness</span>
            <span className="badge kind" style={{background:"var(--panel2)", borderColor:"var(--accent)", color:"var(--accent)"}}>TrueForge (forced) · local execution is TrueForge</span>
          </div>
          <label className="opt-row checkbox">
            <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
            <span>Reuse if library has it</span>
          </label>
        </div>

        <div className="job-list-header">
          <span className="dim" style={{fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4}}>Chats</span>
          <span className="dim" style={{fontSize: 10}}>{displayJobs.length} · single server</span>
          <button className="link-btn" onClick={clearHistory} title="Clear local chat history (server jobs remain)">Clear</button>
          <button className="link-btn" onClick={refresh} title="Refresh from single server">↻</button>
        </div>
        <div className="job-list">
          {displayJobs.length === 0 && <div className="empty" style={{ padding: 16 }}>No chats yet — run a paper to start. Chats are stored in localStorage and mirrored to the single server so web and TUI share them.</div>}
          {displayJobs.map((j) => {
            const isActive = activeJob === j.job_uuid;
            const short = j.job_uuid.slice(0, 8);
            return (
              <div key={j.job_uuid}
                className={`job-item ${isActive ? "active" : ""}`}
                onClick={() => selectJob(j.job_uuid)} role="button" tabIndex={0}
                onKeyDown={(e)=>{ if(e.key==="Enter") selectJob(j.job_uuid); }}>
                <div className="job-item-title">Paper reproduction</div>
                <div className="arxiv">{j.arxiv_id || (j as any).source || short}</div>
                <div className="job-item-meta dim">{short} · click to resume</div>
              </div>
            );
          })}
        </div>
        <div className="sidebar-footer dim">
          Single server at <code>:{typeof window!=="undefined" ? window.location.port || "8788" : "8788"}</code> — TUI and web share jobs via the server; web also mirrors to localStorage.
        </div>
      </aside>

      <main className="main">
        {!activeJob && (
          <div className="empty hero">
            <h2>Polaris AI — BYOK Paper Reproduction</h2>
            <p>Enter an arXiv ID or drop a PDF to reproduce a research paper end-to-end.</p>
            <p className="dim">READ → RESEARCH → PLAN → CODE → <strong>VERIFY</strong> → local project</p>
            <p className="dim">VERIFY checks that every plan delta and every initial/additional-query signal was persisted.</p>
            <p className="dim">Checks the library first; reuses or generates based on your choice. Library is read-only — Polaris never writes to GitHub.</p>
            <div className="hero-actions">
              <button className="btn secondary" onClick={()=> setShowSettings(true)}>{byok?.configured ? `Provider: ${byok.model} — change` : "Add LLM provider (BYOK) — one click"}</button>
              <span className="dim" style={{marginLeft: 8, fontSize: 12}}>TUI: <code>polaris run</code> · <code>Ctrl+S</code> or <code>:settings</code> to change provider</span>
            </div>
            {byok && !byok.configured && <div className="hero-warn">⚠ Provider not configured — add your key to start. Same provider is used by web and TUI (single server).</div>}
          </div>
        )}

        {activeJob && (
          <>
            <div className="header">
              <span className="job-title">arXiv {jobs.find((j) => j.job_uuid === activeJob)?.arxiv_id ?? ""} <span className="dim" style={{fontWeight:400, fontSize: 11}}>· {activeJob.slice(0,8)}</span></span>
              {status ? <StatusBadge status={status.status} /> : <span className="dim" style={{fontSize: 11}}>loading…</span>}
              <button className="btn secondary" style={{marginLeft: "auto", padding: "4px 10px", fontSize: 11}} onClick={()=> setShowSettings(true)} title="Change LLM provider — one click">Provider: {byok?.model ?? "…" } ⚙</button>
            </div>

            {status?.awaiting_approval && (
              <PlanApproval plan={status.awaiting_approval.plan} feedback={feedback}
                setFeedback={setFeedback} onApprove={approve} />
            )}

            <TraceTimeline traces={traces} />
            <div ref={traceEndRef} />
          </>
        )}
      </main>
    </div>
  );
}

function ByokSettings({ status, onClose, onSaved }: { status: ByokStatus | null; onClose: () => void; onSaved: (s: ByokStatus) => void }) {
  const [baseUrl, setBaseUrl] = useState(status?.base_url ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(status?.model ?? "gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setSaving(true);
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) { setError("base URL must be http(s)://"); setSaving(false); return; }
    if (apiKey && apiKey.length > 10000) { setError("key too long"); setSaving(false); return; }
    const payload: Record<string, string> = { base_url: baseUrl, model };
    if (apiKey) payload.api_key = apiKey;
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok || data.error) { setError(data.error ?? "Could not save provider"); setSaving(false); return; }
      if (!data.configured) { setError("Enter an API key to run Polaris."); setSaving(false); return; }
      setApiKey(""); onSaved(data as ByokStatus);
    } catch (err) {
      setError((err as Error).message); setSaving(false);
    }
  };
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="BYOK provider settings" onClick={onClose}>
    <form className="settings-modal" onSubmit={save} onClick={(e)=> e.stopPropagation()}>
      <div className="modal-title">LLM provider <button type="button" onClick={onClose} aria-label="Close">×</button></div>
      <p>One-click to switch provider/model. Used by the <strong>single server</strong> — web and TUI share the same provider. Keys are held in server memory only, never in localStorage or returned to the browser.</p>
      <label>OpenAI-compatible base URL
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" required autoFocus />
        <span className="field-hint dim">Any OpenAI-compatible endpoint (OpenAI, Together, local vLLM, etc.)</span>
      </label>
      <label>Model
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" required />
        <span className="field-hint dim">Applied to READ/RESEARCH/PLAN/CODE/VERIFY (or set per-agent via env)</span>
      </label>
      <label>API key
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={status?.configured ? "Leave blank to keep current key" : "sk-... (required)"} autoComplete="off" />
        <span className="field-hint dim">{status?.configured ? "Leave blank to keep — only sent when you change it" : "BYOK — you pay your provider directly"}</span>
      </label>
      {error && <div className="settings-error">{error}</div>}
      <div className="actions">
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" type="submit" disabled={saving}>{saving ? "Saving…" : "Save provider"}</button>
      </div>
      <div className="dim" style={{marginTop: 10, fontSize: 11}}>Also configurable via <code>.env</code> or <code>~/.polaris/.env</code> (env wins). TUI: <code>:settings</code> or <code>Ctrl+S</code> inside the chat.</div>
    </form>
  </div>;
}

function PlanApproval({ plan, feedback, setFeedback, onApprove }: {
  plan: Record<string, unknown>;
  feedback: string;
  setFeedback: (s: string) => void;
  onApprove: (a: boolean) => void;
}) {
  const planSteps = (plan["plan"] as string[]) ?? [];
  const deltas = (plan["deltas_from_base"] as string[]) ?? [];
  return (
    <div className="approval">
      <h3>Plan ready — awaiting approval <span className="dim" style={{fontWeight:400, fontSize: 12}}>(web and TUI share the same gate)</span></h3>
      {plan["intends_to_prove"] != null && (
        <div className="plan-section"><label>Claims to prove</label><p>{String(plan["intends_to_prove"])}</p></div>
      )}
      {plan["proof_method"] != null && (
        <div className="plan-section"><label>Proof method</label><p>{String(plan["proof_method"])}</p></div>
      )}
      {deltas.length > 0 && (
        <div className="plan-section"><label>Deltas from base</label>
          <ul>{deltas.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
      {planSteps.length > 0 && (
        <div className="plan-section"><label>Files to build ({planSteps.length})</label>
          <ol>{planSteps.map((s, i) => <li key={i}><code>{s}</code></li>)}</ol>
        </div>
      )}
      {(plan["custom_kernels"] as any) && (
        <div className="plan-section"><label>Custom kernels</label><p>{JSON.stringify(plan["custom_kernels"])}</p></div>
      )}
      <details className="raw-plan"><summary>Raw JSON</summary>
        <pre>{JSON.stringify(plan, null, 2)}</pre>
      </details>
      <label className="feedback-label dim">Feedback (optional — sent to planner if you Reject, or for :rerun/:modify)</label>
      <textarea placeholder="Feedback for replanning — leave blank to approve as-is…" value={feedback}
        onChange={(e) => setFeedback(e.target.value)} rows={2} />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn approve" onClick={() => onApprove(true)}>✓ Approve &amp; Code</button>
        <button className="btn reject" onClick={() => onApprove(false)}>✗ Reject / Replan</button>
      </div>
    </div>
  );
}

function TraceTimeline({ traces }: { traces: TraceEvent[] }) {
  const grouped = useMemo(() => {
    const m: Record<string, TraceEvent[]> = {};
    for (const t of traces) (m[t.agent] ??= []).push(t);
    return PHASE_ORDER.filter((p) => m[p]?.length).map((p) => ({ phase: p, events: m[p]! }));
  }, [traces]);

  if (traces.length === 0)
    return <div className="traces"><div className="empty">Waiting for agent traces… The pipeline is <code>READ → RESEARCH → PLAN → CODE → VERIFY</code>. VERIFY checks that every plan delta + initial signals were persisted.</div></div>;

  return (
    <div className="traces">
      {grouped.map(({ phase, events }) => (
        <PhaseGroup key={phase} phase={phase} events={events} />
      ))}
    </div>
  );
}

function PhaseGroup({ phase, events }: { phase: string; events: TraceEvent[] }) {
  const [open, setOpen] = useState(true);
  const outputs = events.filter((e) => e.kind === "OUTPUT");
  const errors = events.filter((e) => e.kind === "ERROR");
  return (
    <div className={`phase-group ${phase}`}>
      <div className="phase-header" onClick={() => setOpen(!open)} role="button" tabIndex={0} onKeyDown={(e)=>{ if(e.key==="Enter") setOpen(!open); }}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className={`agent ${phase}`}>{PHASE_LABEL[phase] ?? phase}</span>
        <span className="phase-count">{events.length} events</span>
        {outputs.length > 0 && <span className="phase-output">● output</span>}
        {errors.length > 0 && <span className="phase-error">✗ {errors.length} error</span>}
      </div>
      {open && (
        <div className="phase-events">
          {events.map((t, i) => (
            <div key={i} className={`trace ${t.kind}`}>
              <span className="ts">{new Date(t.ts).toLocaleTimeString([], { hour12: false })}</span>
              <span className="kind">{t.kind}</span>
              <span className="msg">
                {t.step && <strong>{t.step}: </strong>}
                {t.conclusion}
                {t.tool && <em className="muted"> [{t.tool}]</em>}
                {t.output_query && t.kind === "OUTPUT" && (
                  <> → <a href={String(t.output_query)} target="_blank" rel="noreferrer">{String(t.output_query).slice(0, 60)}</a></>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Library view (Polaris coded-implementation browser) ───────────────────────
function LibraryView() {
  const [papers, setPapers] = useState<PaperRepo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<PaperRepo | null>(null);
  const [impl, setImpl] = useState<Implementation | null>(null);
  const [activeFile, setActiveFile] = useState<ImplementationFile | null>(null);
  const [implLoading, setImplLoading] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback((q: string) => {
    setLoading(true);
    const qs = q ? `?query=${encodeURIComponent(q)}` : "";
    fetch(`/api/papers${qs}`).then((r) => r.json()).then((d) => {
      setPapers(d.papers ?? []); setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { doSearch(""); }, [doSearch]);

  const onQuery = (v: string) => {
    setQuery(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(v), 300);
  };

  const openPaper = useCallback((p: PaperRepo) => {
    setSelected(p); setImpl(null); setActiveFile(null); setImplLoading(true);
    fetch(`/api/papers/${p.repo_name}`).then((r) => r.json()).then((d: Implementation) => {
      setImpl(d); setImplLoading(false);
      const firstCode = d.files?.find((f) => /\.(py|ts|js|sh)$/.test(f.path));
      if (firstCode) setActiveFile(firstCode);
    }).catch(() => setImplLoading(false));
  }, []);

  const fileByPath = (path: string) => impl?.files.find((f) => f.path === path) ?? null;
  const selectFile = (path: string) => {
    const f = fileByPath(path);
    if (f) setActiveFile(f);
    else {
      fetch(`/api/papers/${selected!.repo_name}?file=${encodeURIComponent(path)}`)
        .then((r) => r.json()).then((d) => setActiveFile({ path, content: d.content ?? "" }));
    }
  };

  const blobs = impl?.tree.filter((f) => f.type === "blob") ?? [];

  return (
    <div className="app library">
      <aside className="sidebar">
        <div className="logo">Polaris<span>AI</span> <span className="lib-tag">Library</span></div>
        <input className="search-box" placeholder="Search implementations… (read-only, never writes)" value={query}
          onChange={(e) => onQuery(e.target.value)} aria-label="Search implementations" />
        <div className="job-list">
          {loading && <div className="empty" style={{ padding: 20 }}>Loading…</div>}
          {!loading && papers.length === 0 && <div className="empty" style={{ padding: 20 }}>No implementations found</div>}
          {papers.map((p) => (
            <div key={p.repo_name} className={`job-item ${selected?.repo_name === p.repo_name ? "active" : ""}`}
              onClick={() => openPaper(p)} role="button" tabIndex={0} onKeyDown={(e)=>{ if(e.key==="Enter") openPaper(p); }}>
              <div className="paper-title">{p.arxiv_id || p.repo_name}</div>
              <div className="arxiv">{p.description.slice(0, 70)}</div>
              <div className="dim" style={{fontSize: 10, marginTop: 2}}>{p.stars} ★ · {p.updated_at?.slice(0,10) ?? ""}</div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {!selected && <div className="empty hero"><h2>Implementation Library — Read-Only</h2>
          <p>Browse coded reproductions from <code>PolarisAI-Implementations</code>. Polaris never creates, commits, or pushes repos — all retrieval is read-only.</p>
          <p className="dim">Use <code>search_polaris_papers</code> / <code>get_polaris_implementation</code> MCP tools from code agents.</p></div>}

        {selected && (
          <>
            <div className="header">
              <span className="job-title">{selected.arxiv_id || selected.repo_name}</span>
              <a className="gh-link" href={selected.html_url} target="_blank" rel="noreferrer">GitHub ↗ (read-only)</a>
            </div>
            <div className="impl-split">
              <div className="file-tree">
                {implLoading && <div className="empty" style={{ padding: 16 }}>Loading files…</div>}
                {blobs.map((f) => (
                  <div key={f.path} className={`file-item ${activeFile?.path === f.path ? "active" : ""}`}
                    onClick={() => selectFile(f.path)}>
                    <span className="file-icon">📄</span>{f.path}
                  </div>
                ))}
                {blobs.length === 0 && !implLoading && <div className="empty" style={{ padding: 16 }}>No files</div>}
              </div>
              <div className="file-viewer">
                {activeFile ? (
                  <>
                    <div className="file-path">{activeFile.path}</div>
                    <pre className="file-content">{activeFile.content}</pre>
                  </>
                ) : <div className="empty" style={{ padding: 40 }}>Select a file to view its contents</div>}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ─── App shell with view switcher + single-server BYOK ───────────────────────
function App() {
  const [view, setView] = useState<"pipeline" | "library">("pipeline");
  const [byok, setByok] = useState<ByokStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const refreshByok = useCallback(() => {
    fetch("/api/config").then((r) => r.json()).then((d: ByokStatus) => {
      setByok(d);
      if (!d.configured) setShowSettings(true);
    }).catch(() => {});
  }, []);
  useEffect(refreshByok, [refreshByok]);

  return (
    <div className="shell">
      <nav className="navbar">
        <div className="logo nav-logo">Polaris<span>AI</span> <span className="dim" style={{fontSize: 10, marginLeft: 6, fontWeight: 400}}>BYOK · trueForge</span></div>
        <div className="nav-tabs">
          <button className={`nav-tab ${view === "pipeline" ? "active" : ""}`} onClick={() => setView("pipeline")}>Pipeline</button>
          <button className={`nav-tab ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}>Library</button>
        </div>
        <div style={{marginLeft: "auto", display: "flex", gap: 8, alignItems: "center"}}>
          <span className="dim" style={{fontSize: 11, fontFamily: "var(--mono)"}}>{byok?.configured ? `● ${byok.model}` : "○ no provider"}</span>
          <button className={`btn ${byok?.configured ? "secondary" : ""}`} style={{padding: "6px 12px", fontSize: 12}} onClick={()=> setShowSettings(true)} title="One-click to change LLM provider">
            {byok?.configured ? "Change provider" : "Add provider"}
          </button>
        </div>
      </nav>
      {view === "pipeline" ? <PipelineView byok={byok} setByok={setByok} showSettings={showSettings} setShowSettings={setShowSettings} /> : <LibraryView />}
      {showSettings && view==="pipeline" && <ByokSettings status={byok} onClose={() => setShowSettings(false)} onSaved={(next) => { setByok(next); setShowSettings(false); }} />}
      {/* Global BYOK modal for library view as well */}
      {showSettings && view==="library" && <ByokSettings status={byok} onClose={() => setShowSettings(false)} onSaved={(next) => { setByok(next); setShowSettings(false); }} />}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
