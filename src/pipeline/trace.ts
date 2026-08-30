/**
 * Structured traces + live event bus — port of shared/trace.py & worker/traces.py.
 *
 * The polaris backend used Redis (live tail) + Supabase (durable). For the CLI we
 * keep an in-process bus: every emit is fanned out to live subscribers (TUI, web
 * SSE) and appended to a per-job history buffer so late subscribers can replay.
 */
import type { AgentName } from "../state.ts";

export type TraceKind = "STEP" | "OUTPUT" | "STATUS" | "AWAIT_USER" | "ERROR";

export interface TraceEvent {
  job_uuid: string;
  agent: AgentName;
  kind: TraceKind;
  step: string;
  tool: string;
  conclusion: string;
  output_query: string;
  ts: string;
}

export type TraceListener = (event: TraceEvent) => void;

export interface StatusEntry {
  status: string;
  github_url?: string;
  [k: string]: unknown;
}

class TraceBus {
  private listeners = new Map<string, Set<TraceListener>>();
  private history = new Map<string, TraceEvent[]>();
  private state = new Map<string, StatusEntry>();

  emit(event: TraceEvent): void {
    const list = this.history.get(event.job_uuid);
    if (list) list.push(event);
    else this.history.set(event.job_uuid, [event]);
    const subs = this.listeners.get(event.job_uuid);
    if (subs) for (const fn of subs) {
      try {
        fn(event);
      } catch {
        /* a listener must never break the pipeline */
      }
    }
  }

  subscribe(jobUuid: string, fn: TraceListener, replayFrom = 0): () => void {
    let set = this.listeners.get(jobUuid);
    if (!set) {
      set = new Set();
      this.listeners.set(jobUuid, set);
    }
    set.add(fn);
    // replay history the subscriber hasn't seen yet
    const hist = this.history.get(jobUuid) ?? [];
    for (let i = replayFrom; i < hist.length; i++) {
      try {
        fn(hist[i]!);
      } catch {
        /* ignore */
      }
    }
    return () => {
      set?.delete(fn);
    };
  }

  historyOf(jobUuid: string): TraceEvent[] {
    return this.history.get(jobUuid) ?? [];
  }

  setStatus(jobUuid: string, entry: StatusEntry): void {
    this.state.set(jobUuid, entry);
  }

  getStatus(jobUuid: string): StatusEntry | undefined {
    return this.state.get(jobUuid);
  }

  clear(jobUuid: string): void {
    this.history.delete(jobUuid);
    this.state.delete(jobUuid);
    this.listeners.delete(jobUuid);
  }
}

export const traceBus = new TraceBus();

// ─── convenience emitters (mirror worker/traces.py) ─────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

export function emit(
  jobUuid: string,
  agent: AgentName,
  kind: TraceKind,
  fields: { step?: string; tool?: string; conclusion?: string; output_query?: string } = {},
): void {
  traceBus.emit({
    job_uuid: jobUuid,
    agent,
    kind,
    step: fields.step ?? "",
    tool: fields.tool ?? "",
    conclusion: fields.conclusion ?? "",
    output_query: fields.output_query ?? "",
    ts: nowIso(),
  });
}

export function step(
  jobUuid: string,
  agent: AgentName,
  stepName: string,
  opts: { tool?: string; conclusion?: string; output_query?: string } = {},
): void {
  emit(jobUuid, agent, "STEP", { step: stepName, ...opts });
}

export function output(jobUuid: string, agent: AgentName, conclusion: string, output_query = ""): void {
  emit(jobUuid, agent, "OUTPUT", { conclusion, output_query });
}

export function status(jobUuid: string, statusVal: string, extra: Record<string, unknown> = {}): void {
  traceBus.setStatus(jobUuid, { status: statusVal, ...extra });
  emit(jobUuid, "SYSTEM", "STATUS", { step: "status", conclusion: statusVal, output_query: JSON.stringify({ status: statusVal, ...extra }) });
}

export function awaitUser(jobUuid: string, agent: AgentName, conclusion: string, output_query: string): void {
  emit(jobUuid, agent, "AWAIT_USER", { conclusion, output_query });
}

export function error(jobUuid: string, agent: AgentName, conclusion: string): void {
  emit(jobUuid, agent, "ERROR", { conclusion });
}
