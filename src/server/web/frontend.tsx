import React, { useState, useEffect, useRef, useCallback } from "react";
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

function App() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [arxivId, setArxivId] = useState("");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [feedback, setFeedback] = useState("");
  const eventSource = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/jobs")
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {});
  }, []);

  const selectJob = useCallback((uuid: string) => {
    setActiveJob(uuid);
    setTraces([]);
    setFeedback("");
    if (eventSource.current) eventSource.current.close();
    eventSource.current = new EventSource(`/api/jobs/${uuid}/stream`);
    eventSource.current.onmessage = (e) => {
      const ev = JSON.parse(e.data) as TraceEvent;
      setTraces((prev) => [...prev, ev]);
    };
    // poll status for approval detection
    const poll = setInterval(() => {
      fetch(`/api/jobs/${uuid}`)
        .then((r) => r.json())
        .then((d: JobStatus) => {
          setStatus(d);
          if (d.status === "done" || d.status === "failed") clearInterval(poll);
        })
        .catch(() => {});
    }, 1500);
  }, []);

  const runPaper = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!arxivId.trim()) return;
      fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arxiv_id: arxivId.trim() }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.job_uuid) {
            setJobs((prev) => [{ job_uuid: d.job_uuid, arxiv_id: arxivId.trim() }, ...prev]);
            setArxivId("");
            selectJob(d.job_uuid);
          }
        });
    },
    [arxivId, selectJob],
  );

  const approve = useCallback(
    (approved: boolean) => {
      if (!activeJob) return;
      fetch(`/api/jobs/${activeJob}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, feedback }),
      }).then(() => {
        setStatus(null);
        setFeedback("");
      });
    },
    [activeJob, feedback],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          Polaris<span>AI</span>
        </div>
        <div className="job-list">
          {jobs.length === 0 && <div className="empty" style={{ padding: 20 }}>No jobs yet</div>}
          {jobs.map((j) => (
            <div
              key={j.job_uuid}
              className={`job-item ${activeJob === j.job_uuid ? "active" : ""}`}
              onClick={() => selectJob(j.job_uuid)}
            >
              <div>Paper reproduction</div>
              <div className="arxiv">{j.arxiv_id}</div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="header">
          <form className="run-form" onSubmit={runPaper}>
            <input
              placeholder="arXiv ID (e.g. 2301.12345)"
              value={arxivId}
              onChange={(e) => setArxivId(e.target.value)}
            />
            <button className="btn" type="submit">
              Run
            </button>
          </form>
        </div>

        {status?.awaiting_approval && (
          <div className="approval">
            <h3>Plan ready — awaiting approval</h3>
            <pre>{JSON.stringify(status.awaiting_approval.plan, null, 2)}</pre>
            <textarea
              placeholder="Feedback (optional)…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="btn approve" onClick={() => approve(true)}>
                Approve
              </button>
              <button className="btn reject" onClick={() => approve(false)}>
                Reject
              </button>
            </div>
          </div>
        )}

        <div className="traces">
          {!activeJob && (
            <div className="empty">
              <h2>Polaris AI</h2>
              <p>Enter an arXiv ID above to reproduce a research paper.</p>
            </div>
          )}
          {activeJob && traces.length === 0 && <div className="empty">Waiting for agent traces…</div>}
          {traces.map((t, i) => (
            <div key={i} className={`trace ${t.kind}`}>
              <span className="ts">{new Date(t.ts).toLocaleTimeString()}</span>
              <span className={`agent ${t.agent}`}>{t.agent}</span>
              <span className="kind">{t.kind}</span>
              <span className="msg">
                {t.step && <strong>{t.step}: </strong>}
                {t.conclusion}
                {t.tool && <em style={{ color: "var(--muted)" }}> [{t.tool}]</em>}
                {t.output_query && t.kind === "OUTPUT" && (
                  <>
                    {" "}
                    → <a href={String(t.output_query)} target="_blank" rel="noreferrer">{String(t.output_query)}</a>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
