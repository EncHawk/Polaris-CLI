/**
 * Plan approval gate — replaces polaris' Redis `BLPOP` on `polaris:plan_confirm`.
 *
 * runPlan awaits `gate.await(jobUuid, plan)`; the TUI / web UI calls
 * `gate.resolve(jobUuid, { approved, feedback })` to unblock it.
 */
import { awaitUser, step } from "./trace.ts";
import type { PlanOutput, AgentName } from "../state.ts";

export interface ApprovalDecision {
  approved: boolean;
  feedback: string;
}

interface Pending {
  plan: PlanOutput;
  resolve: (d: ApprovalDecision) => void;
}

class ApprovalGate {
  private pending = new Map<string, Pending>();

  /** Emit an AWAIT_USER trace and block until the UI resolves the decision. */
  await(jobUuid: string, agent: AgentName, plan: PlanOutput): Promise<ApprovalDecision> {
    awaitUser(jobUuid, agent, "plan ready -- awaiting user approval", JSON.stringify(plan));
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(jobUuid, { plan, resolve });
    });
  }

  /** Resolve a pending approval (called by the TUI / web / CLI). */
  resolve(jobUuid: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(jobUuid);
    if (!p) return false;
    this.pending.delete(jobUuid);
    step(jobUuid, "PLAN", "user-approval", {
      tool: "/plan/approve",
      conclusion: `${decision.approved ? "approved" : "rejected"}${decision.feedback ? `: ${decision.feedback}` : ""}`,
      output_query: decision.approved ? "proceed to CODE" : "revise plan",
    });
    p.resolve(decision);
    return true;
  }

  hasPending(jobUuid: string): PlanOutput | null {
    return this.pending.get(jobUuid)?.plan ?? null;
  }

  pendingJobs(): string[] {
    return [...this.pending.keys()];
  }
}

export const approvalGate = new ApprovalGate();
