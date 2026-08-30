/**
 * Pipeline shared state — port of polaris/worker-agent/worker/state.py.
 *
 * WorkerState is threaded through every agent node. Each upstream agent emits
 * a structured output that the next agent consumes; `runs` counts gate retries
 * so a too-strict orchestrator can't loop forever.
 */

export interface Experiment {
  name: string;
  what_yielded: string;
}
export interface NovelApproach {
  description: string;
  codeable: boolean;
}
export interface NumberClaim {
  claim: string;
  value: string;
}
export interface RelevantCitation {
  arxiv_id: string;
  why_relevant: string;
}

export interface ReadOutput {
  aim?: string;
  built_on?: string;
  experiments?: Experiment[];
  novel_approach?: NovelApproach;
  numbers?: NumberClaim[];
  relevant_citations?: RelevantCitation[];
  ready?: boolean;
  output_query?: string;
}

export interface ResearchCitation {
  arxiv_id: string;
  what_it_claims: string;
  how_used: string;
}
export interface ResearchOutput {
  citations?: ResearchCitation[];
  ready?: boolean;
  output_query?: string;
}

export interface CustomKernels {
  description?: string;
  details?: string;
}
export interface PlanOutput {
  intends_to_prove?: string;
  proof_method?: string;
  researched_usage?: string;
  deltas_from_base?: string[];
  custom_kernels?: CustomKernels | null;
  plan?: string[];
  ready?: boolean;
  output_query?: string;
}

export interface CodeFile {
  path: string;
  contents: string;
}
export interface RunLog {
  step: string;
  stdout: string;
  stderr: string;
}
export interface CodeOutput {
  files?: CodeFile[];
  run_logs?: RunLog[];
  notes?: string;
  ready?: boolean;
  output_query?: string;
  github_url?: string;
  repo_name?: string;
  push_error?: string;
}

export type AgentName = "SYSTEM" | "READ" | "RESEARCH" | "PLAN" | "CODE" | "ORCHESTRATOR";

export interface WorkerState {
  job_uuid: string;
  paper_id?: string;
  user_id?: string;
  arxiv_id?: string;
  top_n_citations?: number;
  repo_name?: string;
  github_url?: string;
  repo_exists?: boolean;
  execution_mode?: string;
  markdown?: string;

  read?: ReadOutput;
  research?: ResearchOutput;
  plan?: PlanOutput;
  code?: CodeOutput;

  approved?: boolean;
  iteration?: Record<string, number>;
  runs?: Record<string, number>;
  history?: TraceSummary[];
  status?: string;
  error?: string | null;

  _prev_agent_outputs?: Record<string, string>;
  plan_feedback?: string;
  orchestrator_feedback?: string;
  /** Skip the human plan-approval gate (used by the MCP server / non-interactive runs). */
  auto_approve?: boolean;
  /** Execution engine: "local" (BYOK ReAct loop) or "trueforge" (harness). */
  engine?: import("./agents_util/engine.ts").EngineType;
  /** Directory to create the project in (defaults to POLARIS_OUTPUT_DIR or cwd). */
  output_dir?: string;
  /** If an existing library implementation was found, its repo info (so CODE can reuse). */
  library_hit?: { repo_name: string; html_url: string; arxiv_id: string } | null;
}

export interface TraceSummary {
  agent: AgentName;
  step: string;
  conclusion?: string;
}

/** Count every graph invocation, including failed/empty attempts. */
export function markAgentRun(state: WorkerState, agent: string): Record<string, number> {
  const runs: Record<string, number> = { ...(state.runs ?? {}) };
  runs[agent] = (runs[agent] ?? 0) + 1;
  return runs;
}
