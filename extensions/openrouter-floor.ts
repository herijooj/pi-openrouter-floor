// Registers ":floor" twins of every agentic-usable OpenRouter model.
//
// ":floor" is an OpenRouter request-time routing variant (sort providers by
// price, incl. flex-tier endpoints). It is not listed in GET /models, so this
// extension clones the live catalog at startup: every model appears both as
// itself (pi's built-in / advanced provider) and as "<id>:floor" (cheapest
// provider). The list is rebuilt on every pi start, so it stays in sync with
// OpenRouter automatically.
//
// Cost accounting needs no code here: pi uses the provider-billed cost
// OpenRouter reports in the stream (usage.cost, surfaced as
// `totalFromProvider: true`), for floor twins and base models alike.

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

export default async function (pi: ExtensionAPI) {
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
