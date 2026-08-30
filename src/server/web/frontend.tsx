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
}

interface JobStatus {
  job_uuid: string;
  status: string;
  github_url?: string;
  awaiting_approval: { plan: Record<string, unknown> } | null;
}

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

const PHASE_ORDER = ["READ", "RESEARCH", "PLAN", "CODE", "ORCHESTRATOR", "SYSTEM"];
const PHASE_LABEL: Record<string, string> = {
  READ: "Read", RESEARCH: "Research", PLAN: "Plan", CODE: "Code",
  ORCHESTRATOR: "Orchestrator", SYSTEM: "System",
};

function StatusBadge({ status }: { status: string }) {
  const cls = status === "done" ? "done" : status === "failed" ? "failed"
    : status.startsWith("awaiting") ? "awaiting_user_approval" : "running";
  return <span className={`status-badge ${cls}`}>{status}</span>;
}

function useJobs() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const refresh = useCallback(() => {
    fetch("/api/jobs").then((r) => r.json()).then((d) => setJobs(d.jobs ?? [])).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  return { jobs, refresh };
}

// ─── Pipeline view ──────────────────────────────────────────────────────────────
function PipelineView() {
  const { jobs, refresh } = useJobs();
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [arxivId, setArxivId] = useState("");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [feedback, setFeedback] = useState("");
  const [engine, setEngine] = useState<"local" | "trueforge">("local");
  const [reuse, setReuse] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<{ kind: string; arxiv_id: string; title: string; pages: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const eventSource = useRef<EventSource | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const selectJob = useCallback((uuid: string) => {
    setActiveJob(uuid);
    setTraces([]);
    setFeedback("");
    if (eventSource.current) eventSource.current.close();
    eventSource.current = new EventSource(`/api/jobs/${uuid}/stream`);
    eventSource.current.onmessage = (e) => {
      setTraces((prev) => [...prev, JSON.parse(e.data) as TraceEvent]);
    };
    const poll = setInterval(() => {
      fetch(`/api/jobs/${uuid}`).then((r) => r.json()).then((d: JobStatus) => {
        setStatus(d);
        if (d.status === "done" || d.status === "failed") clearInterval(poll);
      }).catch(() => {});
    }, 1500);
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
    const form = new FormData();
    if (uploadFile) form.append("paper", uploadFile);
    if (arxivId.trim()) form.append("arxiv_id", arxivId.trim());
    form.append("engine", engine);
    form.append("reuse_if_exists", reuse ? "1" : "0");
    fetch("/api/run", { method: "POST", body: form }).then((r) => r.json()).then((d) => {
      if (d.job_uuid) {
        refresh();
        setArxivId("");
        setUploadFile(null);
        setUploadPreview(null);
        selectJob(d.job_uuid);
      }
    });
  }, [arxivId, uploadFile, engine, reuse, selectJob, refresh]);

  const approve = useCallback((approved: boolean) => {
    if (!activeJob) return;
    fetch(`/api/jobs/${activeJob}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved, feedback }),
    }).then(() => { setStatus(null); setFeedback(""); });
  }, [activeJob, feedback]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">Polaris<span>AI</span></div>
        <form className="run-form" onSubmit={runPaper}>
          <input placeholder="arXiv ID (e.g. 2301.12345)" value={arxivId}
            onChange={(e) => setArxivId(e.target.value)} />
          <button className="btn" type="submit" disabled={!arxivId.trim() && !uploadFile}>Run</button>
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
        >
          <input ref={fileInput} type="file" accept=".pdf,.md,.markdown,.txt,.tex"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          {uploading ? <span className="dz-text">Extracting text…</span>
            : uploadFile ? <span className="dz-text">📎 {uploadFile.name}</span>
            : <span className="dz-text">Drop a PDF / .md / .tex here<br /><span className="dim">or click to browse</span></span>}
        </div>
        {uploadPreview && uploadPreview.kind !== "error" && (
          <div className="upload-meta">
            <span className="badge kind">{uploadPreview.kind}</span>
            {uploadPreview.arxiv_id && <span className="badge">arXiv {uploadPreview.arxiv_id}</span>}
            {uploadPreview.pages > 0 && <span className="badge">{uploadPreview.pages}p</span>}
            {uploadPreview.title && <div className="upload-title dim">{uploadPreview.title.slice(0, 60)}</div>}
          </div>
        )}
        {uploadPreview?.kind === "error" && <div className="upload-meta error">{uploadPreview.title}</div>}

        {/* Engine + reuse options */}
        <div className="run-options">
          <label className="opt-row"><span className="opt-label">Engine</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value as "local" | "trueforge")}>
              <option value="local">Local BYOK</option>
              <option value="trueforge">trueForge harness</option>
            </select>
          </label>
          <label className="opt-row checkbox">
            <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
            <span>Reuse if library has it</span>
          </label>
        </div>

        <div className="job-list">
          {jobs.length === 0 && <div className="empty" style={{ padding: 20 }}>No jobs yet</div>}
          {jobs.map((j) => (
            <div key={j.job_uuid}
              className={`job-item ${activeJob === j.job_uuid ? "active" : ""}`}
              onClick={() => selectJob(j.job_uuid)}>
              <div>Paper reproduction</div>
              <div className="arxiv">{j.arxiv_id || (j as any).source}</div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {!activeJob && (
          <div className="empty hero">
            <h2>Polaris AI</h2>
            <p>Enter an arXiv ID or drop a PDF to reproduce a research paper end-to-end.</p>
            <p className="dim">READ → RESEARCH → PLAN → CODE → push to GitHub</p>
            <p className="dim">Checks the library first; reuses or generates based on your choice.</p>
          </div>
        )}

        {activeJob && (
          <>
            <div className="header">
              <span className="job-title">arXiv {jobs.find((j) => j.job_uuid === activeJob)?.arxiv_id ?? ""}</span>
              {status && <StatusBadge status={status.status} />}
              {status?.github_url && (
                <a className="gh-link" href={status.github_url} target="_blank" rel="noreferrer">GitHub ↗</a>
              )}
            </div>

            {status?.awaiting_approval && (
              <PlanApproval plan={status.awaiting_approval.plan} feedback={feedback}
                setFeedback={setFeedback} onApprove={approve} />
            )}

            <TraceTimeline traces={traces} />
          </>
        )}
      </main>
    </div>
  );
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
      <h3>Plan ready — awaiting approval</h3>
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
          <ol>{planSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      )}
      <details className="raw-plan"><summary>Raw JSON</summary>
        <pre>{JSON.stringify(plan, null, 2)}</pre>
      </details>
      <textarea placeholder="Feedback (optional)…" value={feedback}
        onChange={(e) => setFeedback(e.target.value)} />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn approve" onClick={() => onApprove(true)}>Approve</button>
        <button className="btn reject" onClick={() => onApprove(false)}>Reject</button>
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
    return <div className="traces"><div className="empty">Waiting for agent traces…</div></div>;

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
  return (
    <div className={`phase-group ${phase}`}>
      <div className="phase-header" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className={`agent ${phase}`}>{PHASE_LABEL[phase] ?? phase}</span>
        <span className="phase-count">{events.length} events</span>
        {outputs.length > 0 && <span className="phase-output">output</span>}
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
                  <> → <a href={String(t.output_query)} target="_blank" rel="noreferrer">{String(t.output_query)}</a></>
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
        <input className="search-box" placeholder="Search implementations…" value={query}
          onChange={(e) => onQuery(e.target.value)} />
        <div className="job-list">
          {loading && <div className="empty" style={{ padding: 20 }}>Loading…</div>}
          {!loading && papers.length === 0 && <div className="empty" style={{ padding: 20 }}>No implementations found</div>}
          {papers.map((p) => (
            <div key={p.repo_name} className={`job-item ${selected?.repo_name === p.repo_name ? "active" : ""}`}
              onClick={() => openPaper(p)}>
              <div className="paper-title">{p.arxiv_id || p.repo_name}</div>
              <div className="arxiv">{p.description.slice(0, 60)}</div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        {!selected && <div className="empty hero"><h2>Implementation Library</h2>
          <p>Browse coded reproductions from the Polaris library.</p></div>}

        {selected && (
          <>
            <div className="header">
              <span className="job-title">{selected.arxiv_id || selected.repo_name}</span>
              <a className="gh-link" href={selected.html_url} target="_blank" rel="noreferrer">GitHub ↗</a>
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

// ─── App shell with view switcher ───────────────────────────────────────────────
function App() {
  const [view, setView] = useState<"pipeline" | "library">("pipeline");
  return (
    <div className="shell">
      <nav className="navbar">
        <div className="logo nav-logo">Polaris<span>AI</span></div>
        <div className="nav-tabs">
          <button className={`nav-tab ${view === "pipeline" ? "active" : ""}`} onClick={() => setView("pipeline")}>Pipeline</button>
          <button className={`nav-tab ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}>Library</button>
        </div>
      </nav>
      {view === "pipeline" ? <PipelineView /> : <LibraryView />}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
