/**
 * Minimal OpenAI-compatible chat client (BYOK) — the transport under the ReAct
 * loop and the orchestrator. Pure fetch, no SDK dependency, so any
 * OpenAI-compatible endpoint works (DeepInfra, OpenAI, Together, local vLLM …).
 */
import { getSettings } from "../config/settings.ts";
import type { ChatMessage, ToolDef } from "../agents/types.ts";

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface CompletionChunk {
  delta: {
    content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    } | null>;
  } | null;
  finish_reason?: string | null;
}

export interface CompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class LlmError extends Error {}

function assertKey(): { apiKey: string; baseUrl: string } {
  const s = getSettings();
  if (!s.POLARIS_API_KEY) throw new LlmError("POLARIS_API_KEY is not set — configure a provider in .env (BYOK).");
  return { apiKey: s.POLARIS_API_KEY, baseUrl: s.POLARIS_BASE_URL.replace(/\/$/, "") };
}

export async function chatCompletion(params: ChatParams): Promise<CompletionResponse> {
  const { apiKey, baseUrl } = assertKey();
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.2,
    max_tokens: params.maxTokens ?? 8192,
  };
  if (params.tools?.length) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice ?? "auto";
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as CompletionResponse;
}

export async function* chatCompletionStream(params: ChatParams): AsyncIterable<CompletionChunk> {
  const { apiKey, baseUrl } = assertKey();
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    temperature: params.temperature ?? 0.2,
    max_tokens: params.maxTokens ?? 8192,
    stream: true,
  };
  if (params.tools?.length) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice ?? "auto";
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new LlmError(`LLM stream HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        if (choice) {
          yield {
            delta: choice.delta ?? null,
            finish_reason: choice.finish_reason ?? null,
          };
        }
      } catch {
        /* keep partial frames in buffer for next pass */
      }
    }
  }
}
