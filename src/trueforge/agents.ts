/**
 * Polaris agents expressed as trueForge AgentSpecs — the manifests `polaris setup`
 * saves into the trueForge registry. Each agent reuses the ported polaris system
 * prompt and attaches the polaris MCP server (completion + arxiv + github tools).
 * The CODE agent additionally gets trueForge's sandbox-as-tool.
 */
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { getSettings } from "../config/settings.ts";
import { READ_SYSTEM_PROMPT } from "../agents/read.ts";
import { RESEARCH_SYSTEM_PROMPT } from "../agents/research.ts";
import { PLAN_SYSTEM_PROMPT } from "../agents/plan.ts";
import { CODE_SYSTEM_PROMPT } from "../agents/code.ts";
import { VERIFY_SYSTEM_PROMPT } from "../agents/verify.ts";

export const POLARIS_MCP_NAME = "polaris";
export const POLARIS_PROVIDER_NAME = "polaris-byok";
export const POLARIS_MODEL_NAME = "default";

/** The BYOK model FQN the agents reference: `<provider>/<model>`. */
export function polarisModelFqn(): string {
  return `${POLARIS_PROVIDER_NAME}/${POLARIS_MODEL_NAME}`;
}

type Spec = TrueForgeApi.AgentSpec;

function baseSpec(instructions: string): Spec {
  const s = getSettings();
  return {
    model: { name: polarisModelFqn() },
    instructions,
    mcpServers: [{ name: POLARIS_MCP_NAME, preload: true, enableTools: ["@all"] }],
    config: {
      iterationLimit: Math.max(s.AGENT_MAX_STEPS * 4, 16),
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      askUserQuestions: { enabled: false },
    },
  };
}

export function polarisAgentSpecs(): Record<"read" | "research" | "plan" | "code" | "verify", Spec> {
  const code = baseSpec(CODE_SYSTEM_PROMPT);
  return {
    read: baseSpec(READ_SYSTEM_PROMPT),
    research: baseSpec(RESEARCH_SYSTEM_PROMPT),
    plan: baseSpec(PLAN_SYSTEM_PROMPT),
    code: {
      ...code,
      config: { ...code.config!, sandbox: { enabled: true } },
    },
    verify: baseSpec(VERIFY_SYSTEM_PROMPT),
  };
}

export const POLARIS_AGENT_NAMES = ["polaris-read", "polaris-research", "polaris-plan", "polaris-code", "polaris-verify"] as const;
