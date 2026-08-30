/**
 * TUI — a finely polished full-screen chat interface for `polaris run`.
 *
 * Execution: **forced TrueForge harness** — local execution IS the TrueForge
 * harness (no global run, no server delegation). The harness is booted by
 * `ensureTrueForgeForRun` before the pipeline starts.
 *
 * Layout (alternate screen buffer):
 *   ┌ header: Polaris · paper · TrueForge · provider · phase/status ─┐
 *   │ transcript: agent messages, tool steps, plan cards,            │
 *   │             user lines (scroll with ↑/↓, PgUp/PgDn)             │
 *   ├ hints ─────────────────────────────────────────────────────────┤
 *   │ input line (typed feedback / commands, or settings field)       │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Chat semantics:
 *   - while the plan awaits approval: Enter on empty/y approves, `n` rejects,
 *     any other typed text is sent as rejection feedback (replan)
 *   - after the run: `:rerun [feedback]`, `:modify <feedback>`, `:path`, `:help`, `:q`
 *   - at any time: Ctrl+S or :settings opens the BYOK provider modal (apiKey/baseUrl/model)
 *
 * When stdin/stdout are not a TTY (piped output, CI), falls back to line-mode.
 */
import { runOne, type Job } from "../pipeline/run.ts";
import { traceBus, type TraceEvent } from "../pipeline/trace.ts";
import { approvalGate } from "../pipeline/approval.ts";
import type { PlanOutput, WorkerState } from "../state.ts";
import { byokStatus, setRuntimeByok } from "../config/settings.ts";

const C = {
  SYSTEM: "\x1b[90m",
  READ: "\x1b[34m",
  RESEARCH: "\x1b[35m",
  PLAN: "\x1b[33m",
  CODE: "\x1b[32m",
  VERIFY: "\x1b[92m",
  ORCHESTRATOR: "\x1b[31m",
  USER: "\x1b[36m",
  ACCENT: "\x1b[36m",
  WARN: "\x1b[33m",
  OK: "\x1b[32m",
  ERR: "\x1b[31m",
};
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REV = "\x1b[7m";
const UNDER = "\x1b[4m";

class InterruptedError extends Error {
  exitCode = 130;
  constructor(msg = "interrupted") { super(msg); this.name = "InterruptedError"; }
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Visible width of an ANSI-styled string. */
export function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** Greedy word-wrap an ANSI-styled string to `width` visible columns. */
export function wrapText(s: string, width: number): string[] {
  if (width < 4) return [s];
  const out: string[] = [];
  let line = "";
  let lineLen = 0;
  for (const word of s.split(" ")) {
    const parts: string[] = [];
    let rest = word;
    while (visibleLen(rest) > width) {
      let cut = width;
      while (cut > 1 && visibleLen(rest.slice(0, cut)) > width) cut -= 1;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    for (const part of parts) {
      const wlen = visibleLen(part);
      if (lineLen === 0) {
        line = part;
        lineLen = wlen;
      } else if (lineLen + 1 + wlen <= width) {
        line += " " + part;
        lineLen += 1 + wlen;
      } else {
        out.push(line);
        line = part;
        lineLen = wlen;
      }
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function ts(t: string): string {
  const d = new Date(t);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

function truncateStyled(s: string, width: number): string {
  if (visibleLen(s) <= width) return s;
  let cut = width;
  while (cut > 1 && visibleLen(s.slice(0, cut)) > width) cut -= 1;
  return s.slice(0, cut) + RESET;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line-mode fallback (non-TTY)
// ─────────────────────────────────────────────────────────────────────────────

function renderTraceLine(ev: TraceEvent): string {
  const c = C[ev.agent] ?? "";
  const kindTag = ev.kind === "STEP" ? "" : `${DIM}${ev.kind}${RESET} `;
  const toolTag = ev.tool ? `${DIM}[${ev.tool}]${RESET}` : "";
  const conclusion = ev.conclusion ? ` ${ev.conclusion}` : "";
  const oq = ev.output_query && ev.kind === "OUTPUT" ? ` → ${ev.output_query}` : "";
  return `${c}${ts(ev.ts)}${RESET} ${c}${BOLD}${ev.agent.padEnd(12)}${RESET} ${kindTag}${ev.step ? `${ev.step}:` : ""}${conclusion} ${toolTag}${oq}`;
}

async function* signalLines(): AsyncGenerator<string> {
  const lineBuf: string[] = [];
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf.push(...decoder.decode(value).split("\n"));
    while (lineBuf.length > 1) {
      yield lineBuf.shift()!;
    }
  }
  if (lineBuf.length) yield lineBuf[0]!;
}

async function runLineTui(job: Job): Promise<void> {
  console.log(`\n${BOLD}Polaris AI${RESET} ${DIM}— paper reproduction pipeline (TrueForge harness)${RESET}\n`);
  console.log(`${DIM}Paper: ${job.arxiv_id ?? (job.markdown ? "uploaded file" : "??")} · TrueForge${RESET}\n`);

  // Still check BYOK in line mode, but via env only — no interactive prompt in piped mode
  if (!byokStatus().configured) {
    console.log(`${C.WARN}BYOK not configured — set POLARIS_API_KEY (or run in a TTY for the setup wizard)${RESET}\n`);
  }

  let approvalPending = false;
  const unsub = traceBus.subscribe(jobUuid(job), (ev) => {
    console.log(renderTraceLine(ev));
    if (ev.kind === "AWAIT_USER" && !approvalPending && !job.auto_approve) {
      approvalPending = true;
      promptApprovalLineMode(jobUuid(job))
        .catch(() => {})
        .finally(() => { approvalPending = false; });
    }
  });
  const final = await runOne(job);
  unsub();
  printFinalLineMode(final);
}

function printFinalLineMode(final: WorkerState): void {
  const code = final.code;
  if (final.error || !code?.ready) {
    console.log(`\n${C.ORCHESTRATOR}${BOLD}FAILED${RESET}: ${final.error ?? "implementation was not completed"}\n`);
  } else if (code.workspace_path) {
    console.log(`\n${C.CODE}${BOLD}DONE${RESET} → ${code.workspace_path}\n`);
  } else {
    console.log(`\n${BOLD}Done${RESET} (status: ${final.status ?? "done"})\n`);
  }
}

async function promptApprovalLineMode(jobUuid: string): Promise<void> {
  const plan = approvalGate.hasPending(jobUuid);
  if (!plan) return;
  console.log(`\n${C.PLAN}${BOLD}Plan ready for approval:${RESET}\n`);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\n${DIM}Approve? [Y]es / [n]o / [f]eedback${RESET}`);
  for await (const line of signalLines()) {
    const t = line.trim().toLowerCase();
    if (t === "" || t === "y" || t === "yes") {
      approvalGate.resolve(jobUuid, { approved: true, feedback: "" });
      console.log(`${C.CODE}Approved — proceeding to CODE${RESET}\n`);
      return;
    }
    if (t === "n" || t === "no") {
      approvalGate.resolve(jobUuid, { approved: false, feedback: "" });
      console.log(`${C.ORCHESTRATOR}Rejected — replanning${RESET}\n`);
      return;
    }
    if (t === "f" || t === "feedback") {
      console.log(`${DIM}Enter feedback then press Enter:${RESET}`);
      for await (const fb of signalLines()) {
        approvalGate.resolve(jobUuid, { approved: false, feedback: fb.trim() });
        console.log(`${C.ORCHESTRATOR}Feedback sent — replanning${RESET}\n`);
        return;
      }
    }
    console.log(`${DIM}Press Y to approve, N to reject, or F for feedback${RESET}`);
  }
}

function jobUuid(job: Job): string {
  return job.job_uuid ?? (job.job_uuid = crypto.randomUUID());
}

// No global run — local execution IS the TrueForge harness. All runs go
// through `runOne` with `engine: "trueforge"` (forced) and the harness is
// booted by `ensureTrueForgeForRun` in the CLI before the TUI starts.

// ─────────────────────────────────────────────────────────────────────────────
// Full-screen chat TUI — polished
// ─────────────────────────────────────────────────────────────────────────────

type Mode = "running" | "approval" | "done" | "settings" | "help";

interface FollowUp {
  type: "quit" | "rerun" | "modify" | "settings" | "help" | "none";
  feedback: string;
}

class ChatTui {
  private lines: string[] = [];
  private view = 0; // rows scrolled up from bottom; 0 = stick to bottom
  private input = "";
  private mode: Mode = "running";
  private hints = "running… · ↑↓ scroll · PgUp/PgDn · Ctrl+S settings · :help";
  private headerLeft = "Polaris";
  private headerRight = "";
  private pendingApproval: string | null = null;
  private commandResolver: ((cmd: string) => void) | null = null;
  private commandReject: ((err: Error) => void) | null = null;
  private pendingInterrupt: Error | null = null;
  private disposed = false;
  private escBuf = "";
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private resizeHandler: (() => void) | null = null;
  private renderQueued = false;
  // settings form state
  private settingsFields: { label: string; key: "baseUrl"|"model"|"apiKey"; value: string; placeholder: string; secret?: boolean }[] = [];
  private settingsFocused = 0;
  private settingsError = "";
  private settingsSaved = false;

  constructor(private baseJob: Job) {
    const s = byokStatus();
    this.settingsFields = [
      { label: "Quick Preset", key: "baseUrl", value: "Press 1:OpenAI 2:Anthropic 3:DeepInfra 4:Together 5:Ollama 6:OpenRouter 7:Groq", placeholder: "Press 1-7 to select" },
      { label: "Provider base URL", key: "baseUrl", value: s.base_url, placeholder: "https://api.openai.com/v1" },
      { label: "Model", key: "model", value: s.model, placeholder: "gpt-4o-mini" },
      { label: "API key", key: "apiKey", value: "", placeholder: s.configured ? "•••••••• (leave blank to keep)" : "sk-..." , secret: true },
    ];
    this.updateHeaderProvider();
  }

  private updateHeaderProvider(): void {
    const st = byokStatus();
    this.headerRight = st.configured ? `● ${st.model}` : `○ no key`;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    process.stdin.setRawMode?.(true);
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"); // alt screen, hide cursor, clear
    this.render();
    this.resizeHandler = () => this.render();
    try { process.stdout.on("resize", this.resizeHandler); } catch {}
    this.reader = Bun.stdin.stream().getReader();
    this.readKeys().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { process.stdout.off?.("resize", this.resizeHandler!); } catch {}
    try { this.reader?.cancel().catch(() => {}); } catch {}
    process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen
    try { process.stdin.setRawMode?.(false); } catch {}
  }

  private async readKeys(): Promise<void> {
    while (!this.disposed) {
      const { done, value } = await this.reader!.read();
      if (done) break;
      this.handleChunk(this.decoder.decode(value, { stream: true }));
    }
  }

  // ── transcript ───────────────────────────────────────────────────────────

  add(raw: string): void {
    const { width } = this.size();
    for (const l of wrapText(raw.replace(/\s+$/, ""), Math.max(width - 2, 20))) {
      this.lines.push(l);
    }
    if (this.view !== 0) this.view = 0;
    this.render();
  }

  addBlock(lines: string[]): void {
    const { width } = this.size();
    for (const b of lines) {
      for (const l of wrapText(b.replace(/\s+$/, ""), Math.max(width - 2, 20))) {
        this.lines.push(l);
      }
    }
    this.render();
  }

  setHeader(left: string, right: string): void {
    this.headerLeft = left;
    this.headerRight = right;
    this.updateHeaderProvider();
    this.render();
  }

  setHeaderRight(right: string): void {
    this.headerRight = right;
    this.updateHeaderProvider();
    this.render();
  }

  setHints(h: string): void {
    this.hints = h;
    this.render();
  }

  // ── trace handling ───────────────────────────────────────────────────────

  onTrace(ev: TraceEvent): void {
    const c = C[ev.agent] ?? "";
    const time = `${DIM}${ts(ev.ts)}${RESET}`;
    switch (ev.kind) {
      case "STATUS":
        this.setHeaderRight(ev.conclusion);
        this.add(`${C.SYSTEM}${time} ${BOLD}${ev.conclusion}${RESET}`);
        return;
      case "ERROR":
        this.add(`${C.ORCHESTRATOR}${time} ${BOLD}✗ ${ev.agent}${RESET} ${ev.conclusion}`);
        return;
      case "OUTPUT":
        this.add(`${c}${time} ${BOLD}● ${ev.agent}${RESET} ${ev.conclusion}${ev.output_query ? ` ${DIM}→ ${ev.output_query}${RESET}` : ""}`);
        return;
      case "AWAIT_USER": {
        const plan = ev.output_query ? (()=>{ try{ return JSON.parse(ev.output_query) as PlanOutput }catch{ return approvalGate.hasPending(ev.job_uuid) } })() : approvalGate.hasPending(ev.job_uuid);
        this.showApproval(ev.job_uuid, plan);
        return;
      }
      default: {
        const tool = ev.tool ? ` ${DIM}[${ev.tool}]${RESET}` : "";
        const step = ev.step ? `${BOLD}${ev.step}:${RESET} ` : "";
        this.add(`${c}${time} ${BOLD}${ev.agent.padEnd(10)}${RESET} ${step}${ev.conclusion}${tool}`);
      }
    }
  }

  showApproval(jobUuid: string, plan: PlanOutput | null): void {
    if (!plan || this.pendingApproval) return;
    this.pendingApproval = jobUuid;
    this.mode = "approval";
    const { width } = this.size();
    const inner = Math.max(width - 6, 34);
    const box: string[] = [];
    const row = (s: string) => box.push(`${C.PLAN}│${RESET} ` + s);
    box.push(`${C.PLAN}╭─ PLAN — awaiting your approval ${"─".repeat(Math.max(inner - 33, 3))}╮${RESET}`);
    for (const [label, val] of [
      ["prove", plan.intends_to_prove ?? ""],
      ["method", plan.proof_method ?? ""],
    ] as const) {
      const wrapped = wrapText(val || "(empty)", inner - 10);
      wrapped.forEach((w, i) =>
        row(`${i === 0 ? `${BOLD}${label.padEnd(8)}${RESET} ` : `${" ".repeat(9)}`}${w}`),
      );
    }
    if (plan.deltas_from_base?.length) {
      row(`${BOLD}deltas  ${RESET} `);
      for (const d of plan.deltas_from_base.slice(0, 8)) {
        for (const [i, w] of wrapText(`• ${d}`, inner - 4).entries()) {
          row(`${i === 0 ? "" : "  "}${w}`);
        }
      }
    }
    if (plan.plan?.length) {
      row(`${BOLD}files   ${RESET} `);
      for (const [i, f] of plan.plan.slice(0, 15).entries()) {
        for (const [j, w] of wrapText(`${i + 1}. ${f}`, inner - 4).entries()) {
          row(`${j === 0 ? "" : "  "}${w}`);
        }
      }
      if (plan.plan.length > 15) row(`${DIM}… ${plan.plan.length - 15} more${RESET}`);
    }
    box.push(`${C.PLAN}╰${"─".repeat(inner + 2)}╯${RESET}`);
    this.addBlock(box);
    this.setHints("⏎ approve · n reject · type feedback + ⏎ replan · Ctrl+S provider");
  }

  onUserLine(text: string): void {
    this.add(`${C.USER}${BOLD}[you]${RESET} ${text}`);
  }

  setDone(final: WorkerState): void {
    this.mode = "done";
    this.pendingApproval = null;
    const code = final.code;
    if (final.verify && final.verify.checks_passed === false) {
      this.setHeaderRight("verify failed");
      this.add(`${C.WARN}${BOLD}⚠ VERIFY FAILED${RESET} ${final.verify.missing_signals?.join("; ") ?? final.verify.output_query ?? ""}`);
      if (final.verify.files_missing?.length) this.add(`${DIM}missing files: ${final.verify.files_missing.join(", ")}${RESET}`);
      this.add(`${DIM}Use :modify <feedback> to fix, or :rerun to start over · ${code?.workspace_path ?? ""}${RESET}`);
    } else if (final.error || !code?.ready) {
      this.setHeaderRight("failed");
      this.add(`${C.ORCHESTRATOR}${BOLD}✗ FAILED${RESET} ${final.error ?? "implementation was not completed"}`);
    } else if (code?.workspace_path) {
      this.setHeaderRight(final.verify?.checks_passed ? "done ✓ verify" : "done");
      this.add(`${C.CODE}${BOLD}● DONE${RESET} ${code.workspace_path} ${DIM}(${(code.files ?? []).length} files · ${code.repo_name ?? ""})${RESET}`);
      if (final.verify?.checks_passed) {
        this.add(`${C.VERIFY}  ↳ verify: ${final.verify.output_query ?? "all signals persisted"}${RESET}`);
      }
    } else {
      this.setHeaderRight(final.status ?? "done");
      this.add(`${BOLD}● Done${RESET} ${DIM}status: ${final.status ?? "done"}${RESET}`);
    }
    this.setHints(":rerun [feedback] · :modify <feedback> · :path · :settings provider · :help · :q quit");
  }

  /** Resolves on the next submitted input while in `done`/`running` mode. */
  readCommand(): Promise<string> {
    if (this.pendingInterrupt) {
      const err = this.pendingInterrupt;
      this.pendingInterrupt = null;
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      this.commandResolver = resolve;
      this.commandReject = reject;
    });
  }

  openSettings(): void {
    const st = byokStatus();
    this.settingsFields[0]!.value = "Press 1:OpenAI 2:Anthropic 3:DeepInfra 4:Together 5:Ollama 6:OpenRouter 7:Groq";
    this.settingsFields[1]!.value = st.base_url;
    this.settingsFields[2]!.value = st.model;
    this.settingsFields[3]!.value = "";
    this.settingsFields[3]!.placeholder = st.configured ? "•••••••• (leave blank to keep)" : "sk-...";
    this.settingsFocused = 0;
    this.settingsError = "";
    this.settingsSaved = false;
    this.mode = "settings";
    this.setHints("Press 1-7 for preset · Tab move · Enter save/next · Esc cancel · Ctrl+S save");
    this.render();
  }

  openHelp(): void {
    this.mode = "help";
    this.setHints("Esc or q to close help");
    this.render();
  }

  // ── key handling ─────────────────────────────────────────────────────────

  private handleChunk(decoded: string): void {
    // Help mode: any key closes
    if (this.mode === "help") {
      for (const ch of decoded) {
        if (ch === "\x1b" || ch === "q" || ch === "\r" || ch === "\n" || ch === "\x03") {
          if (ch === "\x03") { this.handleInterrupt(); return; }
          this.mode = "done";
          this.setHints(":rerun [feedback] · :modify <feedback> · :path · :settings provider · :help · :q quit");
          this.render();
          return;
        }
      }
      return;
    }
    // Settings mode: modal form
    if (this.mode === "settings") {
      this.handleSettingsChunk(decoded);
      return;
    }
    for (const ch of decoded) {
      if (this.escBuf) {
        this.escBuf += ch;
        // arrow keys, page up/down, F1 etc — view=0 is bottom, larger view = older lines, so Up/PgUp increase view
        if (this.escBuf === "\x1b[A") this.scroll(1);
        else if (this.escBuf === "\x1b[B") this.scroll(-1);
        else if (this.escBuf === "\x1b[5~") this.scroll(Math.max((process.stdout.rows ?? 24)-5, 10)); // PgUp
        else if (this.escBuf === "\x1b[6~") this.scroll(-Math.max((process.stdout.rows ?? 24)-5, 10)); // PgDn
        else if (this.escBuf === "\x1bOP" || this.escBuf === "\x1b[11~") this.openHelp(); // F1
        if (this.escBuf.length >= 3 || /[A-D~P]/.test(ch)) this.escBuf = "";
        continue;
      }
      if (ch === "\x1b") { this.escBuf = "\x1b"; continue; }
      // Ctrl+S (0x13) opens settings from any mode
      if (ch === "\x13") { this.openSettings(); continue; }
      if (ch === "\r" || ch === "\n") { this.submit(); continue; }
      if (ch === "\x7f" || ch === "\b") { this.input = this.input.slice(0, -1); this.render(); continue; }
      if (ch === "\x03") { this.handleInterrupt(); return; }
      if (ch === "\t" || ch < " ") continue;
      this.input += ch;
      this.render();
    }
  }

  private handleInterrupt(): void {
    // Signal cancellation should unwind through existing finally blocks and preserve exit code 130 after cleanup.
    // Do not call process.exit directly — let runTui / cmdStart finally blocks stop the TrueForge harness.
    this.dispose();
    process.exitCode = 130;
    const err = new InterruptedError("Ctrl-C");
    if (this.commandReject) {
      const rej = this.commandReject;
      this.commandResolver = null;
      this.commandReject = null;
      rej(err);
    } else if (this.commandResolver) {
      const res = this.commandResolver;
      this.commandResolver = null;
      this.commandReject = null;
      res(":q");
    } else {
      // No one is waiting (e.g. pipeline is running) — stash for next readCommand
      this.pendingInterrupt = err;
    }
    // If readKeys loop is waiting, it will exit on next read due to disposed flag
  }

  private handleSettingsChunk(decoded: string): void {
    for (const ch of decoded) {
      if (this.escBuf) {
        this.escBuf += ch;
        if (this.escBuf === "\x1b[Z") { // Shift+Tab
          this.settingsFocused = (this.settingsFocused - 1 + this.settingsFields.length) % this.settingsFields.length;
          this.render();
        } else if (this.escBuf === "\x1b[A") {
          this.settingsFocused = (this.settingsFocused - 1 + this.settingsFields.length) % this.settingsFields.length; this.render();
        } else if (this.escBuf === "\x1b[B") {
          this.settingsFocused = (this.settingsFocused + 1) % this.settingsFields.length; this.render();
        }
        if (this.escBuf.length >= 3 || /[A-D~Z]/.test(ch)) this.escBuf = "";
        continue;
      }
      if (ch === "\x1b") { this.escBuf = "\x1b"; continue; }
      if (ch === "\x03") { this.handleInterrupt(); return; }
      if (ch === "\x13") { // Ctrl+S save
        this.saveSettings(); continue;
      }

      // Quick preset keys 1-7 when focused on Preset field
      if (["1", "2", "3", "4", "5", "6", "7"].includes(ch) && this.settingsFocused === 0) {
        const presets: Record<string, { url: string; model: string }> = {
          "1": { url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
          "2": { url: "https://api.anthropic.com/v1", model: "claude-3-5-sonnet-20241022" },
          "3": { url: "https://api.deepinfra.com/v1/openai", model: "meta-llama/Meta-Llama-3.1-70B-Instruct" },
          "4": { url: "https://api.together.xyz/v1", model: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo" },
          "5": { url: "http://localhost:11434/v1", model: "llama3.1" },
          "6": { url: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct" },
          "7": { url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
        };
        const p = presets[ch]!;
        this.settingsFields[1]!.value = p.url;
        this.settingsFields[2]!.value = p.model;
        this.settingsFocused = 3; // Jump directly to API key
        this.render();
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        // Enter: if last field, save, else next field
        if (this.settingsFocused === this.settingsFields.length - 1) this.saveSettings();
        else { this.settingsFocused = (this.settingsFocused + 1) % this.settingsFields.length; this.render(); }
        continue;
      }
      if (ch === "\x1b") { // Esc
        this.mode = "done"; this.settingsError = ""; this.render(); continue;
      }
      if (ch === "\t") { // Tab
        this.settingsFocused = (this.settingsFocused + 1) % this.settingsFields.length;
        this.render(); continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (this.settingsFocused !== 0) {
          const f = this.settingsFields[this.settingsFocused]!;
          f.value = f.value.slice(0, -1);
        }
        this.render(); continue;
      }
      if (ch < " " ) continue;
      if (this.settingsFocused !== 0) {
        const f = this.settingsFields[this.settingsFocused]!;
        if (f.value.length < 10000) f.value += ch;
      }
      this.render();
    }
    if (this.escBuf === "\x1b") {
      this.escBuf = "";
      this.mode = this.pendingApproval ? "approval" : "done";
      if (this.mode === "done" && this.lines.length===0) this.mode="running";
      this.settingsError = "";
      this.render();
    }
  }

  private async saveSettings(): Promise<void> {
    const baseUrl = this.settingsFields[1]!.value.trim();
    const model = this.settingsFields[2]!.value.trim();
    const apiKey = this.settingsFields[3]!.value.trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) { this.settingsError = "base_url must be http(s)://"; this.render(); return; }
    if (apiKey && apiKey.length > 10000) { this.settingsError = "api key too long"; this.render(); return; }
    if (!apiKey && !byokStatus().configured) { this.settingsError = "API key required"; this.render(); return; }
    // Apply locally — TrueForge forced, no global server sync (local harness only)
    setRuntimeByok({ apiKey: apiKey || undefined, baseUrl: baseUrl || undefined, model: model || undefined });
    this.settingsError = "";
    this.settingsSaved = true;
    this.add(`${C.OK}BYOK provider updated: ${byokStatus().model} @ ${byokStatus().base_url}${RESET}`);
    this.updateHeaderProvider();
    // Leave settings mode
    this.mode = this.pendingApproval ? "approval" : (this.lines.length ? "done" : "running");
    if (this.mode === "running") this.setHints("running… · ↑↓ scroll · Ctrl+S settings · :help");
    else if (this.mode === "approval") this.setHints("⏎ approve · n reject · type feedback + ⏎ replan · Ctrl+S provider");
    else this.setHints(":rerun [feedback] · :modify <feedback> · :path · :settings provider · :help · :q quit");
    this.render();
    // Resolve any pending command wait
    if (this.commandResolver && this.mode !== "done") {
      // not in done, don't resolve
    }
  }

  private submit(): void {
    const text = this.input.trim();
    this.input = "";
    // In settings, submit handled separately
    if (this.mode === "approval" && this.pendingApproval) {
      const uuid = this.pendingApproval;
      const resolve = async (approved: boolean, feedback: string) => {
        approvalGate.resolve(uuid, { approved, feedback });
      };
      if (text === "" || /^y(es)?$/i.test(text)) {
        resolve(true, "");
        this.onUserLine("y (approve)");
        this.pendingApproval = null;
        this.mode = "running";
        this.setHints("running… · ↑↓ scroll · Ctrl+S settings · Ctrl-C cancel");
      } else if (/^n(o)?$/i.test(text)) {
        resolve(false, "");
        this.onUserLine("n (reject)");
        this.pendingApproval = null;
        this.mode = "running";
        this.setHints("running… · ↑↓ scroll · Ctrl+S settings · Ctrl-C cancel");
      } else {
        resolve(false, text);
        this.onUserLine(text);
        this.add(`${C.ORCHESTRATOR}feedback sent — replanning${RESET}`);
        this.pendingApproval = null;
        this.mode = "running";
        this.setHints("running… · ↑↓ scroll · Ctrl+S settings · Ctrl-C cancel");
      }
      this.render();
      return;
    }
    if (this.mode === "done" || this.mode === "running") {
      // Running: allow chatting but also check for commands
      if (this.mode === "done") {
        const r = this.commandResolver;
        if (r) {
          this.commandResolver = null;
          if (text) this.onUserLine(text);
          // handle :settings inline
          if (text.trim() === ":settings" || text.trim() === ":provider" || text.trim() === ":s") {
            this.openSettings(); return;
          }
          if (text.trim() === ":help" || text.trim() === "?" || text.trim() === ":h") {
            this.openHelp(); return;
          }
          r(text);
        } else if (text.startsWith(":")) {
          // Interpret immediately if not waiting via readCommand (e.g., typed while still done but no resolver)
          const follow = interpretCommand(text, this, null as any);
          if (follow.type === "settings") { this.openSettings(); return; }
          if (follow.type === "help") { this.openHelp(); return; }
        }
        this.render();
        return;
      }
      // running: echo as chat line
      if (text) {
        if (text === ":settings" || text === ":provider" || text === ":s") { this.openSettings(); return; }
        if (text === ":help" || text === "?" ) { this.openHelp(); return; }
        this.onUserLine(text);
      }
      this.render();
      return;
    }
  }

  private scroll(delta: number): void {
    const { rows } = this.size();
    const body = Math.max(rows - 3, 1);
    this.view = Math.min(Math.max(this.view + delta, 0), Math.max(this.lines.length - body, 0));
    this.render();
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private size(): { width: number; rows: number } {
    return {
      width: Math.max(process.stdout.columns ?? 80, 48),
      rows: Math.max(process.stdout.rows ?? 24, 12),
    };
  }

  render(): void {
    if (this.disposed) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.paint();
    });
  }

  private paint(): void {
    if (this.disposed) return;
    const { width, rows } = this.size();
    const body = Math.max(rows - 3, 1);
    const out: string[] = [];
    // header — two lines? single line with provider pill
    const provider = byokStatus();
    const providerPill = provider.configured ? `${C.OK}● ${provider.model}${RESET}` : `${C.WARN}○ no provider${RESET}`;
    const harnessPill = `${DIM}· TrueForge${RESET}`;
    const left = ` ${C.ACCENT}${BOLD}◆ Polaris${RESET} ${DIM}${this.headerLeft}${RESET}`;
    const right = `${providerPill}${harnessPill} ${DIM}${this.headerRight}${RESET} `;
    const leftLen = visibleLen(left);
    const rightLen = visibleLen(right);
    const pad = Math.max(width - leftLen - rightLen, 1);
    out.push(`\x1b[H\x1b[2K${left}${" ".repeat(pad)}${right}`);

    // second header line: subtle border
    out.push(`\x1b[2K${DIM}${"─".repeat(width)}${RESET}`);

    // transcript or settings/help overlay
    if (this.mode === "settings") {
      this.paintSettings(out, width, body);
    } else if (this.mode === "help") {
      this.paintHelp(out, width, body);
    } else {
      const start = Math.max(this.lines.length - body - this.view, 0);
      const visible = this.lines.slice(start, start + body);
      for (let i = 0; i < body; i++) {
        const l = visible[i];
        out.push(`\x1b[2K${l ?? ""}`);
        if (l == null) continue;
      }
      if (this.view > 0) {
        out[1] = `\x1b[2K${DIM}↑ ${this.view} more lines (PgUp/PgDn or ↑↓ to scroll)${RESET}`;
      }
      // unsaved provider warning bar
      if (!provider.configured && this.mode !== "approval") {
        // inject warning at top of transcript area if not configured
        // we already show in header, but also add a line
      }
    }
    // hints + input
    if (this.mode === "settings") {
      const err = this.settingsError ? `${C.ERR}${this.settingsError}${RESET} ` : "";
      const hint = err || `${DIM}Tab move · Enter save/next · Esc cancel · Ctrl+S save${RESET}`;
      out.push(`\x1b[2K${truncateStyled(hint, width)}`);
      // input line shows current field editing
      const f = this.settingsFields[this.settingsFocused]!;
      const label = `${BOLD}${f.label}${RESET}`;
      const valShown = f.secret && f.value ? "•".repeat(Math.min(f.value.length, 40)) : f.value;
      const cursor = `${REV} ${RESET}`;
      const prefix = `${C.USER}${BOLD}▸ ${label}:${RESET} `;
      const room = Math.max(width - visibleLen(prefix) - 1, 1);
      const shown = valShown.length > room ? valShown.slice(valShown.length - room) : valShown;
      out.push(`\x1b[2K${prefix}${shown}${cursor} ${DIM}[${this.settingsFocused+1}/${this.settingsFields.length}]${RESET}`);
    } else if (this.mode === "help") {
      out.push(`\x1b[2K${DIM}Esc / q to close help${RESET}`);
      out.push(`\x1b[2K${C.USER}${BOLD}▸${RESET} ${DIM}press any key to return${RESET}`);
    } else {
      out.push(`\x1b[2K${DIM}${truncateStyled(this.hints, width)}${RESET}`);
      const inputPrefix = `${C.USER}${BOLD}▸${RESET} `;
      const room = Math.max(width - visibleLen(inputPrefix) - 1, 1);
      const shown = this.input.length > room ? this.input.slice(this.input.length - room) : this.input;
      // show faint placeholder when input empty
      const placeholder = !this.input && this.mode === "done" ? `${DIM}:help for commands · :settings to change provider${RESET}` : "";
      const content = this.input ? shown : placeholder;
      out.push(`\x1b[2K${inputPrefix}${content}${this.input ? `${REV} ${RESET}` : ""}`);
    }
    process.stdout.write(out.join("\n") + "\x1b[J");
  }

  private paintSettings(out: string[], width: number, body: number): void {
    const innerW = Math.min(64, width - 4);
    const pad = Math.max(Math.floor((width - innerW) / 2), 1);
    const padStr = " ".repeat(pad);
    const boxTop = `${C.ACCENT}╭─ BYOK Provider Settings ${"─".repeat(Math.max(innerW - 26, 1))}╮${RESET}`;
    const boxBot = `${C.ACCENT}╰${"─".repeat(innerW)}╯${RESET}`;
    out.push(`\x1b[2K${padStr}${boxTop}`);
    out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET}${" ".repeat(innerW)}${C.ACCENT}│${RESET}`);
    const desc = "TrueForge forced — local execution is the harness. Keys never leave your machine.";
    for (const l of wrapText(desc, innerW - 2)) {
      out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${DIM}${l.padEnd(innerW-2)}${RESET}${C.ACCENT}│${RESET}`);
    }
    const note = "💡 You can change your LLM provider at any point using Ctrl+S or :settings.";
    for (const l of wrapText(note, innerW - 2)) {
      out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${C.WARN}${l.padEnd(innerW-2)}${RESET}${C.ACCENT}│${RESET}`);
    }
    out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET}${" ".repeat(innerW)}${C.ACCENT}│${RESET}`);
    for (let i=0;i<this.settingsFields.length;i++) {
      const f = this.settingsFields[i]!;
      const focused = i===this.settingsFocused;
      const label = f.label.padEnd(18);
      const val = f.secret && f.value ? "•".repeat(Math.min(f.value.length, 32)) : f.value;
      const shown = val || `${DIM}${f.placeholder}${RESET}`;
      const line = `${focused? REV+"▸ "+label : "  "+label} ${focused? BOLD : DIM}${truncateStyled(shown, innerW-22)}${RESET}`;
      // Fill remainder
      const vis = visibleLen(line);
      const fill = Math.max(innerW - vis - 1, 0);
      out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${line}${" ".repeat(fill)}${C.ACCENT}│${RESET}`);
      // underline for focused
      if (focused) {
        out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${" ".repeat(18)} ${DIM}${"─".repeat(innerW-21)}${RESET}${C.ACCENT}│${RESET}`);
      }
    }
    if (this.settingsError) {
      out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${C.ERR}${this.settingsError.padEnd(innerW-1)}${RESET}${C.ACCENT}│${RESET}`);
    }
    if (this.settingsSaved) {
      out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${C.OK}Saved!${RESET}${" ".repeat(innerW-7)}${C.ACCENT}│${RESET}`);
    }
    out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET}${" ".repeat(innerW)}${C.ACCENT}│${RESET}`);
    const hint = `${DIM}Tab/Shift+Tab move  Enter save/next  Esc cancel  Ctrl+S save${RESET}`;
    out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${hint.padEnd(innerW+10)}${C.ACCENT}│${RESET}`);
    out.push(`\x1b[2K${padStr}${boxBot}`);
    // fill remaining body lines
    const used = 10 + this.settingsFields.length*2;
    for (let i=used; i<body; i++) out.push(`\x1b[2K`);
  }

  private paintHelp(out: string[], width: number, body: number): void {
    const innerW = Math.min(68, width - 4);
    const pad = Math.max(Math.floor((width - innerW)/2),1);
    const padStr = " ".repeat(pad);
    const title = `${C.ACCENT}╭─ Help ─${"─".repeat(Math.max(innerW-9,1))}╮${RESET}`;
    const bot = `${C.ACCENT}╰${"─".repeat(innerW)}╯${RESET}`;
    out.push(`\x1b[2K${padStr}${title}`);
    const lines = [
      `${BOLD}While plan awaits approval:${RESET}  ⏎ / y approve  ·  n reject  ·  type feedback + ⏎ replan`,
      `${BOLD}While running:${RESET}  ↑↓ / PgUp/PgDn scroll  ·  Ctrl+S provider settings`,
      `${BOLD}After run:${RESET}  :rerun [feedback]  re-run pipeline (optionally with plan feedback)`,
      `          :modify <feedback>  re-run CODE against produced repo`,
      `          :path              show local project path`,
      `          :settings          change LLM provider (BYOK) — also Ctrl+S`,
      `          :help / ?          this help`,
      `          :q / q             quit`,
      `${DIM}BYOK: set POLARIS_API_KEY + POLARIS_BASE_URL + POLARIS_DEFAULT_MODEL via .env, ~/.polaris/.env, or the provider modal (Ctrl+S / :settings). The single server (polaris serve) shares the same provider and jobs across web and TUI — localStorage in web mirrors server jobs.${RESET}`,
      `${DIM}Pipeline: READ → RESEARCH → PLAN (human approve) → CODE → VERIFY → local project dir. VERIFY checks that every plan delta and every initial/additional-query signal was persisted.${RESET}`,
    ];
    for (const l of lines) {
      for (const w of wrapText(l, innerW-2)) {
        out.push(`\x1b[2K${padStr}${C.ACCENT}│${RESET} ${w.padEnd(innerW-2+ (w.includes("\x1b")? 10:0) )}${C.ACCENT}│${RESET}`);
      }
    }
    out.push(`\x1b[2K${padStr}${bot}`);
    for (let i=lines.length+2; i<body; i++) out.push(`\x1b[2K`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function isInteractive(): boolean {
  return (
    !!process.stdin.isTTY &&
    !!process.stdout.isTTY &&
    typeof process.stdin.setRawMode === "function" &&
    Bun.env.TERM !== "dumb" &&
    Bun.env.TERM !== undefined
  );
}

/** Ask only when needed, or when the user explicitly invokes :settings — now inside TUI modal. */
async function ensureByokOrPrompt(tui: ChatTui): Promise<void> {
  if (byokStatus().configured) return;
  tui.add(`${C.WARN}${BOLD}BYOK not configured — open provider settings with Ctrl+S or :settings${RESET}`);
  tui.add(`${DIM}You can also set POLARIS_API_KEY / POLARIS_BASE_URL / POLARIS_DEFAULT_MODEL in .env or ~/.polaris/.env${RESET}`);
  // Auto-open settings modal so user can fix immediately
  tui.openSettings();
  // Wait until user saves or cancels
  while (tui["mode"] === "settings") {
    await Bun.sleep(100);
    if (byokStatus().configured) break;
  }
}

/**
 * Run the pipeline with the chat TUI (or line-mode fallback). After a run
 * completes the interface stays open: the user can rerun with plan feedback,
 * modify the produced repo with code feedback, or quit.
 */
export async function runTui(job: Job): Promise<void> {
  const uuid = jobUuid(job);
  if (!isInteractive()) return runLineTui(job);

  const tui = new ChatTui(job);
  await tui.start();
  // If BYOK missing, prompt inside TUI before starting
  if (!byokStatus().configured) {
    await ensureByokOrPrompt(tui);
    if (!byokStatus().configured) {
      tui.add(`${C.ERR}No provider configured — cannot start. Use :settings or Ctrl+S to add one, then :rerun.${RESET}`);
    }
  }
  let current: Job = { ...job, job_uuid: uuid };
  let lastFinal: WorkerState | null = null;

  try {
    for (;;) {
      // If not configured, don't start run — wait for provider
      if (!byokStatus().configured) {
        tui.setHints(":settings to add provider · :q quit · :help");
        let followUp: FollowUp = { type: "none", feedback: "" };
        while (followUp.type === "none") {
          const cmd = await tui.readCommand();
          followUp = interpretCommand(cmd, tui, lastFinal);
          if (followUp.type === "help") { tui.openHelp(); followUp = { type: "none", feedback: "" }; continue; }
        }
        if (followUp.type === "settings") {
          tui.openSettings();
          while (tui["mode"] === "settings") await Bun.sleep(80);
          continue;
        }
        if (followUp.type === "quit") {
          printExitSummary(lastFinal);
          return;
        }
        if (byokStatus().configured) {
          tui.add(`${C.OK}Provider configured — ready to run.${RESET}`);
        } else continue;
      }

      // Interactive paper prompt mode if no paper was specified at launch
      if (!current.arxiv_id && !current.markdown) {
        tui.setHeader("polaris start · TrueForge", "ready");
        tui.addBlock([
          `${C.ACCENT}${BOLD}Polaris AI${RESET} ${DIM}— paper reproduction agent harness (TrueForge)${RESET}`,
          `${C.OK}● TrueForge & local MCP APIs online${RESET}`,
          `${C.OK}● Current Provider:${RESET} ${byokStatus().configured ? `${byokStatus().model} @ ${byokStatus().base_url}` : `${C.WARN}No provider configured${RESET}`}`,
          `${C.WARN}💡 Note: You can change your LLM provider at ANY point using Ctrl+S or :settings${RESET}`,
          `${DIM}─────────────────────────────────────────────────────────────────────────────${RESET}`,
          `${BOLD}Enter an arXiv ID or paper file path to run reproduction:${RESET}`,
          `${DIM}  Examples: 2403.09876  |  https://arxiv.org/abs/2403.09876  |  paper.pdf${RESET}`,
        ]);
        tui.setHints("Enter arXiv ID / file path + ⏎ · Ctrl+S provider · :help · :q quit");

        for (;;) {
          const inputStr = await tui.readCommand();
          const trimmed = inputStr.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith(":")) {
            const followUp = interpretCommand(trimmed, tui, lastFinal);
            if (followUp.type === "settings") {
              tui.openSettings();
              while (tui["mode"] === "settings") await Bun.sleep(80);
              continue;
            }
            if (followUp.type === "help") { tui.openHelp(); continue; }
            if (followUp.type === "quit") { printExitSummary(lastFinal); return; }
            continue;
          }

          const { extractPaperFile, extractArxivId } = await import("../tools/upload.ts");
          const { existsSync } = await import("node:fs");

          if (existsSync(trimmed)) {
            tui.add(`${DIM}Extracting text from ${trimmed}…${RESET}`);
            try {
              const res = await extractPaperFile(trimmed);
              current.markdown = res.markdown;
              current.arxiv_id = res.arxiv_id;
              tui.add(`${C.OK}Extracted ${res.kind} · ${res.pages} page(s) · ${res.chars} chars${RESET}`);
              break;
            } catch (e) {
              tui.add(`${C.ERR}Could not extract text from ${trimmed}: ${(e as Error).message}${RESET}`);
              continue;
            }
          }

          const aid = extractArxivId(trimmed);
          if (aid) {
            current.arxiv_id = aid;
            break;
          } else {
            tui.add(`${C.WARN}Please enter a valid arXiv ID (e.g. 2403.09876) or paper file path (e.g. paper.pdf)${RESET}`);
          }
        }
      }

      const runUuid = jobUuid(current);
      current.job_uuid = runUuid;
      // Forced TrueForge — local execution is the harness, no global delegation
      tui.setHeader(
        `${current.arxiv_id ?? (current.markdown ? "uploaded paper" : "??")} · TrueForge${current.reuse_if_exists ? " · reuse" : ""}`,
        "starting",
      );
      tui.setHints("running via TrueForge… · ↑↓ scroll · Ctrl+S provider · Ctrl-C cancel");
      tui.add(`${DIM}job ${runUuid} (TrueForge harness)${RESET}`);

      let final: WorkerState;
      {
        const unsub = traceBus.subscribe(runUuid, (ev) => tui.onTrace(ev));
        try {
          final = await runOne(current);
        } finally {
          unsub();
        }
      }
      lastFinal = final;
      tui.setDone(final);

      // chat loop: wait for a post-run command
      let followUp: FollowUp = { type: "none", feedback: "" };
      while (followUp.type === "none") {
        const cmd = await tui.readCommand();
        followUp = interpretCommand(cmd, tui, lastFinal);
        if (followUp.type === "help") { tui.openHelp(); followUp = { type: "none", feedback: "" }; continue; }
      }
      if (followUp.type === "settings") {
        tui.openSettings();
        while (tui["mode"] === "settings") await Bun.sleep(80);
        // stay on same final, let user rerun manually
        continue;
      }
      if (followUp.type === "help") { tui.openHelp(); continue; }
      if (followUp.type === "quit") {
        traceBus.clear(runUuid);
        printExitSummary(lastFinal);
        return;
      }
      traceBus.clear(runUuid);
      current = buildFollowUpJob(job, current, lastFinal!, followUp);
      tui.add(`${C.SYSTEM}${BOLD}── new run ──${RESET}`);
    }
  } catch (e) {
    if ((e as Error)?.name === "InterruptedError" || (e as unknown as { exitCode?: number })?.exitCode === 130) {
      process.exitCode = 130;
      return;
    }
    throw e;
  } finally {
    tui.dispose();
  }
}

function interpretCommand(cmd: string, tui: ChatTui, final: WorkerState | null): FollowUp {
  const [head, ...rest] = cmd.trim().split(/\s+/);
  const feedback = rest.join(" ").trim();
  switch ((head ?? "").toLowerCase()) {
    case "":
    case ":q":
    case ":quit":
    case "q":
      return { type: "quit", feedback: "" };
    case ":rerun":
      return { type: "rerun", feedback };
    case ":modify":
      if (!final?.code?.repo_name) {
        tui.add(`${C.ORCHESTRATOR}nothing to modify — no repo was produced${RESET}`);
        return { type: "none", feedback: "" };
      }
      if (!feedback) {
        tui.add(`${C.WARN}Usage: :modify <feedback> — describe what to change${RESET}`);
        return { type: "none", feedback: "" };
      }
      return { type: "modify", feedback };
    case ":settings":
    case ":provider":
    case ":s":
      return { type: "settings", feedback: "" };
    case ":path":
      if (final?.code?.workspace_path) tui.add(`${C.CODE}${final.code.workspace_path}${RESET}`);
      else tui.add(`${C.ORCHESTRATOR}no local project was produced${RESET}`);
      return { type: "none", feedback: "" };
    case ":help":
    case ":h":
    case "?":
    case "help":
      return { type: "help", feedback: "" };
    default:
      tui.add(`${C.ORCHESTRATOR}unknown command "${head}" — try :help${RESET}`);
      return { type: "none", feedback: "" };
  }
}

function buildFollowUpJob(base: Job, last: Job, final: WorkerState, followUp: FollowUp): Job {
  const job: Job = {
    ...base,
    job_uuid: crypto.randomUUID(),
    arxiv_id: last.arxiv_id,
    markdown: last.markdown,
    engine: last.engine,
    reuse_if_exists: false,
    auto_approve: base.auto_approve,
    output_dir: last.output_dir,
  };
  if (followUp.type === "rerun") {
    if (followUp.feedback) job.plan_feedback = followUp.feedback;
    return job;
  }
  const repoName = final.code?.repo_name ?? "";
  return {
    ...job,
    repo_name: repoName,
    repo_exists: true,
    execution_mode: "modify",
    code_feedback: followUp.feedback || "apply the user's requested changes",
  };
}

function printExitSummary(final: WorkerState | null): void {
  const code = final?.code;
  if (final && (final.error || !code?.ready)) {
    console.log(`${C.ORCHESTRATOR}${BOLD}FAILED${RESET}: ${final.error ?? "implementation was not completed"}\n`);
  } else if (code?.workspace_path) {
    console.log(`${C.CODE}${BOLD}DONE${RESET} → ${code.workspace_path}\n`);
  } else {
    console.log(`${BOLD}Bye.${RESET}\n`);
  }
}
