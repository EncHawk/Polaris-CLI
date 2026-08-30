/**
 * Provision a trueForge server with everything polaris needs — idempotent so it
 * is safe to run on every `polaris setup` / `polaris serve`:
 *   1. a custom (BYOK) model provider pointing at the user's OpenAI-compatible endpoint
 *   2. the polaris MCP server (completion + arxiv + github tools)
 *   3. the four polaris agents (read / research / plan / code)
 */
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { getSettings } from "../config/settings.ts";
import {
  POLARIS_MCP_NAME,
  POLARIS_MODEL_NAME,
  POLARIS_PROVIDER_NAME,
  polarisAgentSpecs,
  POLARIS_AGENT_NAMES,
} from "./agents.ts";

export interface ProvisionOptions {
  mcpUrl: string;
  mcpSecret?: string;
}

export interface ProvisionResult {
  providerName: string;
  mcpName: string;
  agents: TrueForgeApi.Agent[];
}

export async function provisionTrueForge(client: TrueForge, opts: ProvisionOptions): Promise<ProvisionResult> {
  const s = getSettings();
  if (!s.POLARIS_API_KEY) throw new Error("POLARIS_API_KEY is not set — cannot provision BYOK model provider.");

  // 1 ── BYOK model provider (custom, OpenAI-compatible) ────────────────────────
  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "custom",
      name: POLARIS_PROVIDER_NAME,
      baseUrl: s.POLARIS_BASE_URL.replace(/\/$/, ""),
      auth: { apiKey: s.POLARIS_API_KEY },
      models: [
        {
          modelId: s.POLARIS_DEFAULT_MODEL,
          name: POLARIS_MODEL_NAME,
          properties: {},
        },
      ],
    },
  });

  // 2 ── polaris MCP server ─────────────────────────────────────────────────────
  const auth: TrueForgeApi.McpServerManifestAuth | undefined = opts.mcpSecret
    ? { type: "header", headers: { "x-polaris-secret": opts.mcpSecret } }
    : undefined;
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: "remote",
      name: POLARIS_MCP_NAME,
      url: opts.mcpUrl,
      description: "Polaris agent tools: completion signals, arxiv lookup, paper-implementation library search/retrieval, GitHub publishing.",
      auth,
    },
  });

  // 3 ── polaris agents (create if missing, update if present) ──────────────────
  const specs = polarisAgentSpecs();
  const keys = ["read", "research", "plan", "code"] as const;
  const { data: existing } = await client.agents.list();
  const byName = new Map(existing.map((a) => [a.name, a]));

  const agents: TrueForgeApi.Agent[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const name = POLARIS_AGENT_NAMES[i]!;
    const spec = specs[key];
    const found = byName.get(name);
    if (found) {
      const { data } = await client.agents.update(found.id, { manifest: spec });
      agents.push(data);
    } else {
      const { data } = await client.agents.create({ name, manifest: spec });
      agents.push(data);
    }
  }

  return { providerName: POLARIS_PROVIDER_NAME, mcpName: POLARIS_MCP_NAME, agents };
}
