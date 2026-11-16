// Registers ":floor" twins of every agentic-usable OpenRouter model.
//
// ":floor" is an OpenRouter request-time routing variant (sort providers by
// price, incl. flex-tier endpoints). It is not listed in GET /models, so this
// extension clones the live catalog at startup: every model appears both as
// itself (pi's built-in / advanced provider) and as "<id>:floor" (cheapest
// provider). The list is rebuilt on every pi start, so it stays in sync with
// OpenRouter automatically.
//
// Session cost estimates for floor twins start from the base model's list
// price, but the provider actually serving a :floor request usually bills
// less. This extension therefore tees the SSE stream for :floor requests,
// captures the billed `usage.cost` OpenRouter reports, and rewrites the
// finalized assistant message so pi's session totals reflect real spend.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const BASE_URL = "https://openrouter.ai/api/v1";
const FETCH_TIMEOUT_MS = 10_000;

interface CatalogModel {
  id: string;
  name?: string;
  supported_parameters?: string[];
  pricing?: Record<string, string | undefined>;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
  architecture?: { input_modalities?: string[]; modality?: string };
  default_parameters?: Record<string, unknown> | null;
}

function isReasoning(m: CatalogModel): boolean {
  const sp = m.supported_parameters ?? [];
  if (sp.some((p) => p === "reasoning" || p === "include_reasoning")) return true;
  if (m.default_parameters && ("reasoning" in m.default_parameters || "reasoning_effort" in m.default_parameters)) return true;
  return /reason|thinking/i.test(`${m.id} ${m.name ?? ""}`);
}

function isAgenticUsable(m: CatalogModel): boolean {
  if (m.id.startsWith("~") || m.id.startsWith("openrouter/")) return true;
  return (m.supported_parameters ?? []).includes("tools") && isReasoning(m);
}

function parsePrice(value?: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function supportsImages(m: CatalogModel): boolean {
  if (m.architecture?.input_modalities) return m.architecture.input_modalities.includes("image");
  return m.architecture?.modality?.includes("multimodal") ?? false;
}

function resolveApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (!fs.existsSync(authPath)) return undefined;
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const entry = auth?.openrouter;
    if (typeof entry === "string") return entry;
    // OAuth entry ("/login openrouter"): bearer token lives in `access`.
    if (typeof entry?.access === "string" && entry.access) return entry.access;
    if (typeof entry?.key === "string") return entry.key;
  } catch {
    // unreadable auth store — fall through
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Billed-cost capture
//
// Wraps global fetch once (guarded via Symbol) to observe SSE streams for
// :floor chat/completions calls: the response body is teed, one copy goes to
// pi untouched, the other is scanned for `usage.cost` keyed by response id.
// Never blocks or breaks the real stream; any parse failure is ignored.
// ---------------------------------------------------------------------------

type Captures = Map<string, Promise<number | undefined>>;

function isFloorRequest(input: unknown, init?: { body?: unknown }): boolean {
  if (typeof init?.body !== "string") return false;
  try {
    const raw = typeof input === "string" ? input : (input as URL).href;
    const url = new URL(raw);
    if (url.hostname !== "openrouter.ai" || !url.pathname.endsWith("/chat/completions")) return false;
    const model = JSON.parse(init.body).model;
    return typeof model === "string" && model.endsWith(":floor");
  } catch {
    return false;
  }
}

async function captureBilledCost(body: ReadableStream<Uint8Array>, captures: Captures): Promise<void> {
  let id: string | undefined;
  let cost: number | undefined;
  let resolve!: (cost: number | undefined) => void;
  const captured = new Promise<number | undefined>((done) => (resolve = done));
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        let chunk: any;
        try {
          chunk = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (!id && typeof chunk.id === "string" && chunk.id) {
          id = chunk.id;
          captures.set(id, captured);
          if (captures.size > 200) captures.delete(captures.keys().next().value!);
        }
        if (typeof chunk.usage?.cost === "number" && Number.isFinite(chunk.usage.cost) && chunk.usage.cost >= 0) {
          cost = chunk.usage.cost;
        }
      }
    }
  } catch {
    // never interrupt the stream
  } finally {
    resolve(cost);
  }
}

function wrapFetchForFloorCost(originalFetch: typeof fetch, captures: Captures): typeof fetch {
  return async (input, init) => {
    if (!isFloorRequest(input, init as any)) return originalFetch(input as any, init);
    const response = await originalFetch(input as any, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) return response;
    const [forPi, forCost] = response.body.tee();
    void captureBilledCost(forCost, captures);
    return new Response(forPi, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

const COST_SYMBOL = Symbol.for("pi-openrouter-floor:cost-capture");

export default async function (pi: ExtensionAPI) {
  // Install the fetch wrapper once per process.
  const globals = globalThis as any;
  if (!globals[COST_SYMBOL]) {
    const captures: Captures = new Map();
    globals[COST_SYMBOL] = { captures, wrapped: true };
    globalThis.fetch = wrapFetchForFloorCost(globalThis.fetch, captures);
  }
  const costState: { captures: Captures; wrapped: boolean } = globals[COST_SYMBOL];

  const onMessageEnd = pi.on as (event: "message_end", handler: (event: any) => Promise<any>) => void;
  onMessageEnd("message_end", async (event) => {
    const message = event?.message;
    if (message?.role !== "assistant") return;
    if (message.provider !== "openrouter-floor") return;
    const responseId: string | undefined = message.responseId;
    if (!responseId) return;
    let captured = costState.captures.get(responseId);
    if (!captured) {
      // message_end can win the race against the tee coroutine; yield once.
      await new Promise((resolve) => setTimeout(resolve, 0));
      captured = costState.captures.get(responseId);
    }
    if (!captured) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const billed = await Promise.race([
      captured,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 250);
      }),
    ]);
    if (timer) clearTimeout(timer);
    costState.captures.delete(responseId);
    if (billed === undefined) return;
    return {
      message: { ...message, usage: { ...message.usage, cost: { ...message.usage.cost, total: billed } } },
    };
  });

  pi.registerCommand("floor", {
    description: "Toggle between the active model and its OpenRouter :floor twin (cheapest provider)",
    handler: async (_args, ctx) => {
      const current = ctx.model;
      if (!current) {
        ctx.ui.notify("No active model to switch", "warning");
        return;
      }
      let target;
      if (current.provider === "openrouter-floor" && current.id.endsWith(":floor")) {
        const baseId = current.id.slice(0, -":floor".length);
        target = ctx.modelRegistry.find("openrouter", baseId);
        if (!target) target = ctx.modelRegistry.find(current.provider, baseId);
      } else {
        target = ctx.modelRegistry.find("openrouter-floor", `${current.id}:floor`);
      }
      if (!target) {
        ctx.ui.notify(`No floor twin for ${current.provider}/${current.id}`, "warning");
        return;
      }
      if (target.provider === current.provider && target.id === current.id) {
        ctx.ui.notify("Already on the floor variant", "info");
        return;
      }
      const ok = await pi.setModel(target);
      if (ok) {
        ctx.ui.notify(`Switched to ${target.provider}/${target.id}`, "info");
      } else {
        ctx.ui.notify(`Authentication not configured for ${target.provider}/${target.id}`, "error");
      }
    },
  });

  let models: CatalogModel[] = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(MODELS_URL, { signal: controller.signal });
      if (!res.ok) return; // keep pi working without the floor twins
      const json = (await res.json()) as { data?: CatalogModel[] };
      models = json.data ?? [];
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return; // network unavailable at startup — skip registration silently
  }

  const usable = models.filter((m) => !m.id.includes(":") && isAgenticUsable(m));
  if (usable.length === 0) return;

  pi.registerProvider("openrouter-floor", {
    name: "OpenRouter (floor)",
    baseUrl: BASE_URL,
    apiKey: resolveApiKey(),
    api: "openai-completions",
    authHeader: true,
    headers: { "X-Title": "pi-openrouter-floor" },
    models: usable.map((m) => ({
      type: "chat" as const,
      id: `${m.id}:floor`,
      name: `${m.name || m.id} (floor)`,
      reasoning: isReasoning(m),
      input: supportsImages(m) ? ["text", "image"] : ["text"],
      cost: {
        input: parsePrice(m.pricing?.prompt),
        output: parsePrice(m.pricing?.completion),
        cacheRead: parsePrice(m.pricing?.input_cache_read),
        cacheWrite: parsePrice(m.pricing?.input_cache_write),
      },
      contextWindow: m.context_length || 128_000,
      maxTokens: m.top_provider?.max_completion_tokens || 16_384,
    })) as any,
  });
}
