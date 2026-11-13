import "server-only";
import OpenAI from "openai";

// One generic adapter for any OpenAI-compatible endpoint (Apertus via Public AI,
// Swisscom, Infomaniak, a self-hosted vLLM …). When that provider does not
// answer and OPENAI_API_KEY is set, ChatGPT stands in. Without any key the app
// runs in demo mode and the agents fall back to their rule-based logic.

export interface LlmStatus {
  enabled: boolean;
  model: string;
  baseUrl: string;
}

/**
 * Env values pasted from web pages often carry invisible characters (zero-width
 * spaces, BOM, line breaks) that break HTTP headers – strip them.
 */
const clean = (v?: string) => v?.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "") || undefined;

const apiKey = () => clean(process.env.LLM_API_KEY);
const openaiKey = () => clean(process.env.OPENAI_API_KEY);
const openaiModel = () => clean(process.env.OPENAI_LLM_MODEL) || "gpt-5.4";

export function llmStatus(): LlmStatus {
  return {
    enabled: Boolean(apiKey() || openaiKey()),
    model: clean(process.env.LLM_MODEL) || "swiss-ai/apertus-v1.5-70b",
    baseUrl: clean(process.env.LLM_BASE_URL) || "https://api.publicai.co/v1",
  };
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const s = llmStatus();
    // Public AI's docs ask clients to identify themselves via User-Agent.
    client = new OpenAI({ apiKey: apiKey(), baseURL: s.baseUrl, defaultHeaders: { "User-Agent": "Einstein/0.1" } });
  }
  return client;
}

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  openaiClient ??= new OpenAI({ apiKey: openaiKey(), baseURL: "https://api.openai.com/v1" });
  return openaiClient;
}

/** Model ids the provider offers (GET /models). */
export async function listModels(): Promise<string[]> {
  if (!apiKey()) return [];
  const page = await getClient().models.list({ timeout: 15_000, maxRetries: 0 });
  return page.data.map((m) => m.id);
}

const sizeOf = (id: string) => Number(id.match(/(\d+)b\b/i)?.[1] ?? 0);

/** Preference: explicitly configured model, then Apertus without "thinking", larger first. */
function candidates(ids: string[]): string[] {
  const apertus = ids
    .filter((id) => /apertus/i.test(id))
    .sort((a, b) => Number(/thinking/i.test(a)) - Number(/thinking/i.test(b)) || sizeOf(b) - sizeOf(a));
  const configured = clean(process.env.LLM_MODEL);
  return [...new Set([...(configured ? [configured] : []), ...apertus, llmStatus().model])];
}

/** A provider may list a model in GET /models and still refuse it for chat – try it. Returns the error, if any. */
async function answers(model: string): Promise<string | null> {
  try {
    // Short timeout, no retries: a hanging provider must not stall the run before the OpenAI fallback.
    await getClient().chat.completions.create({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }, { timeout: 15_000, maxRetries: 0 });
    return null;
  } catch (err) {
    return (err as Error).message.slice(0, 200);
  }
}

interface Target {
  provider: "apertus" | "openai";
  model: string;
}

let resolved: Promise<Target> | null = null;

/**
 * The first model that really answers, in the order of candidates(). Model ids
 * differ between hosts and change with new releases, so nothing is hard-coded.
 * ChatGPT stands in when the provider does not answer and OPENAI_API_KEY is set.
 */
function resolveTarget(): Promise<Target> {
  resolved ??= (async (): Promise<Target> => {
    if (!apiKey()) return { provider: "openai", model: openaiModel() };
    let listError = "";
    const ids = await listModels().catch((err: Error) => ((listError = err.message.slice(0, 200)), [] as string[]));
    const list = candidates(ids);
    let lastError = "";
    for (const m of list) {
      const error = await answers(m);
      if (!error) return { provider: "apertus", model: m };
      lastError = error;
    }
    const why = `${lastError || listError || "no answer"} at ${llmStatus().baseUrl}`;
    if (openaiKey()) {
      console.warn(`[llm] ${list.join(", ")} did not answer (${why}) – using OpenAI ${openaiModel()}`);
      return { provider: "openai", model: openaiModel() };
    }
    // Say why – a wrong key, an outage or a renamed model need different fixes.
    throw new Error(`none of the models answered: ${list.join(", ")} (${why})`);
  })();
  resolved.catch(() => (resolved = null));
  return resolved;
}

/** The model the agents use, as shown in the UI. */
export async function resolveModel(): Promise<string> {
  const t = await resolveTarget();
  return t.provider === "openai" ? `${t.model} (OpenAI${apiKey() ? " fallback" : ""})` : t.model;
}

async function send(t: Target, system: string, user: string, maxTokens: number): Promise<string> {
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const res =
    t.provider === "openai"
      ? // GPT-5 models only take the default temperature and spend part of the
        // completion budget on reasoning, so give them headroom.
        await getOpenAI().chat.completions.create({ model: t.model, reasoning_effort: "low", max_completion_tokens: maxTokens + 4000, messages })
      : await getClient().chat.completions.create({ model: t.model, temperature: 0.2, max_tokens: maxTokens, messages });
  return res.choices[0]?.message?.content?.trim() ?? "";
}

export async function complete(system: string, user: string, maxTokens = 900): Promise<string> {
  const t = await resolveTarget();
  try {
    return await send(t, system, user, maxTokens);
  } catch (err) {
    // Apertus answered the ping but fails now: switch to ChatGPT for this and later calls.
    if (t.provider !== "apertus" || !openaiKey()) throw err;
    console.warn(`[llm] ${t.model} failed (${(err as Error).message.slice(0, 200)}) – switching to OpenAI ${openaiModel()}`);
    const fallback: Target = { provider: "openai", model: openaiModel() };
    resolved = Promise.resolve(fallback);
    return send(fallback, system, user, maxTokens);
  }
}

/**
 * Asks for JSON and parses the first JSON value in the answer. Works without
 * native JSON mode / tool calling, which not every Apertus host supports.
 */
export async function completeJson<T>(system: string, user: string, maxTokens = 900): Promise<T> {
  const text = await complete(
    `${system}\nAnswer with valid JSON only, no prose and no code fences.`,
    user,
    maxTokens,
  );
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error(`LLM returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
