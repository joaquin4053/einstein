import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OntologyError, checkQuery } from "./ontology";

export type Row = Record<string, string>;
export type Trace = (line: string) => void;

export interface LookupHit {
  iri: string;
  label: string;
  rank?: number;
}

export interface ScholarlySource {
  name: string;
  /** true when every call goes through the SemOpenAlex MCP server */
  viaMcp?: boolean;
  /** `trace` receives a note on which backend answered (shown in the agent trace). */
  runSparql(query: string, trace?: Trace): Promise<Row[]>;
  /** Entity linking for a text mention, if the backend offers it (MCP entity_lookup). */
  lookupConcept?(text: string, trace?: Trace): Promise<LookupHit[]>;
  /** SemOpenAlex IRIs matching keywords (MCP keyword_search). */
  keywordSearch?(text: string, trace?: Trace): Promise<string[]>;
  /** What the KG says about an entity, as text (MCP describe_entity). */
  describeEntity?(iri: string, trace?: Trace): Promise<string>;
  /** Set when the server reported its database connection as down in the last few minutes. */
  outage?(): string | null;
}

const MCP_URL = process.env.SEMOPENALEX_MCP_URL || "https://semopenalex.org/mcp";

/** The MCP server gave up on a query – callers switch to a cheaper variant. */
export class SparqlTimeout extends Error {
  constructor() {
    super("The MCP server returned no result for a SPARQL query (time or size limit)");
  }
}

/** The MCP server's preview limit – larger results are fetched page by page. */
const MCP_ROW_LIMIT = 20;
/** Upper bound for queries without their own LIMIT, and pages fetched at once. */
const MCP_MAX_ROWS = 1000;
const MCP_PARALLEL_PAGES = 5;
/**
 * Tool calls in flight at once. Paging, batching and parallel agent steps
 * multiply; the server loses its backend connection pool when flooded.
 */
const MCP_MAX_CONCURRENT = 3;
/** Errors after which the MCP session is dead and a new one is needed. */
const DEAD_SESSION = /connection pool|pool shut down|session|closed|ECONNRESET|socket|fetch failed|terminated/i;

/** The query with its trailing LIMIT replaced by one page. */
function page(query: string, offset: number, size: number) {
  return `${query.replace(/\bLIMIT\s+\d+\s*$/i, "").trimEnd()}\nLIMIT ${size} OFFSET ${offset}`;
}

interface ToolSchema {
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

/**
 * SemOpenAlex MCP server. Every query goes through its tools, and only through
 * them: SPARQL via execute_sparql_query (paged past its 20-row preview),
 * concept linking via entity_lookup and keyword_search, context via
 * describe_entity. Einstein has no other route to SemOpenAlex.
 */
class McpSource implements ScholarlySource {
  name = "SemOpenAlex MCP";
  viaMcp = true;
  private client: Promise<{ client: Client; tools: Map<string, ToolSchema> }> | null = null;
  private running = 0;
  private lastOutage: { at: number; message: string } | null = null;

  outage() {
    return this.lastOutage && Date.now() - this.lastOutage.at < 5 * 60_000 ? this.lastOutage.message : null;
  }
  private waiting: (() => void)[] = [];

  /** Waits for a free slot – at most MCP_MAX_CONCURRENT tool calls at once. */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MCP_MAX_CONCURRENT) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Drops a dead session so the next call opens a new one – unless another call already did. */
  private reset(dead: NonNullable<McpSource["client"]>) {
    if (this.client !== dead) return;
    this.client = null;
    dead.then(({ client }) => client.close()).catch(() => {});
  }

  private connect() {
    if (!this.client) {
      this.client = (async () => {
        const client = new Client({ name: "einstein", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
          requestInit: { headers: { Authorization: mcpAuthorization()! } },
        });
        await client.connect(transport);
        const { tools } = await client.listTools();
        return { client, tools: new Map(tools.map((t) => [t.name, t.inputSchema as ToolSchema])) };
      })();
      this.client.catch(() => (this.client = null));
    }
    return this.client;
  }

  /**
   * Calls a tool and unwraps its `{ output, success, message }` JSON answer.
   * When the session died (e.g. "Connection pool shut down"), it reconnects
   * once and retries.
   */
  private async call<T>(name: string, args: Record<string, unknown>, retried = false): Promise<T> {
    const conn = this.connect();
    try {
      return await this.slot(() => this.callOnce<T>(conn, name, args));
    } catch (err) {
      if (!DEAD_SESSION.test((err as Error).message)) throw err;
      if (retried) {
        this.lastOutage = { at: Date.now(), message: (err as Error).message };
        throw err;
      }
      this.reset(conn);
      await new Promise((r) => setTimeout(r, 1000));
      return this.call<T>(name, args, true);
    }
  }

  private async callOnce<T>(conn: ReturnType<McpSource["connect"]>, name: string, args: Record<string, unknown>): Promise<T> {
    const { client } = await conn;
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
    const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { output: T; success: boolean; message: string | null };
    if (res.isError || !parsed.success) throw new Error(parsed.message ?? `MCP ${name} failed`);
    return parsed.output;
  }

  /**
   * Arguments for a tool that takes one text or IRI, named as in its schema
   * (discovered at runtime). Null when the server does not offer the tool.
   */
  private async textArgs(tool: string, value: string, prefer: RegExp) {
    const schema = (await this.connect()).tools.get(tool);
    if (!schema) return null;
    const strings = Object.entries(schema.properties ?? {}).filter(([, p]) => !p.type || p.type === "string").map(([k]) => k);
    const key = strings.find((k) => prefer.test(k)) ?? strings.find((k) => schema.required?.includes(k)) ?? strings[0];
    return key ? { [key]: value } : null;
  }

  private async sparqlPage(query: string): Promise<Row[]> {
    const rows = await this.call<Row[] | null>("execute_sparql_query", { query });
    // A null output means the server gave up on the query – let the caller
    // switch to its cheaper variant.
    if (rows === null) throw new SparqlTimeout();
    return rows;
  }

  private async sparqlPaged(query: string, trace?: Trace): Promise<Row[]> {
    checkQuery(query);
    const limit = Number(query.match(/\bLIMIT\s+(\d+)\s*$/i)?.[1] ?? MCP_MAX_ROWS);
    if (limit <= MCP_ROW_LIMIT) {
      const rows = await this.sparqlPage(query);
      trace?.("-- answered via MCP execute_sparql_query");
      return rows;
    }
    const rows: Row[] = [];
    let pages = 0;
    // First page alone (most results fit), then several pages at a time.
    for (let offset = 0, n = 1; offset < limit; offset += MCP_ROW_LIMIT * n, n = MCP_PARALLEL_PAGES) {
      const wave = [];
      for (let o = offset; o < Math.min(limit, offset + MCP_ROW_LIMIT * n); o += MCP_ROW_LIMIT) {
        wave.push(this.sparqlPage(page(query, o, Math.min(MCP_ROW_LIMIT, limit - o))));
      }
      const results = await Promise.all(wave);
      pages += results.length;
      // Pages come back in order; a short one is the last.
      const end = results.findIndex((r) => r.length < MCP_ROW_LIMIT);
      for (const r of end < 0 ? results : results.slice(0, end + 1)) rows.push(...r);
      if (end >= 0) break;
    }
    trace?.(`-- answered via MCP execute_sparql_query (${pages} page${pages > 1 ? "s" : ""} of ${MCP_ROW_LIMIT} rows)`);
    return rows;
  }

  async runSparql(query: string, trace?: Trace): Promise<Row[]> {
    let error: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.sparqlPaged(query, trace);
      } catch (err) {
        if (err instanceof SparqlTimeout) {
          trace?.("-- MCP query timed out");
          throw err;
        }
        if (err instanceof OntologyError) throw err;
        error = err as Error;
      }
    }
    trace?.(`-- MCP failed twice: ${error!.message}`);
    throw error!;
  }

  async lookupConcept(text: string, trace?: Trace): Promise<LookupHit[]> {
    const out = await this.call<{ candidateEntities: LookupHit[] }>("entity_lookup", {
      text,
      candidateTypes: ["https://semopenalex.org/ontology/Concept"],
    });
    // candidateTypes is a hint only – works with matching titles come back too.
    const concepts = out.candidateEntities.filter((c) => c.iri.includes("semopenalex.org/concept/"));
    trace?.(`MCP entity_lookup("${text}") → ${concepts.map((c) => `${c.label} (${c.rank ?? "?"} works)`).join(", ") || "no concept"}`);
    return concepts;
  }

  async keywordSearch(text: string, trace?: Trace): Promise<string[]> {
    const args = await this.textArgs("keyword_search", text, /^(query|text|keywords?|q|search)$/i);
    if (!args) return [];
    // The answer's shape is not fixed – collect the SemOpenAlex IRIs in it.
    const out = JSON.stringify(await this.call<unknown>("keyword_search", args));
    const iris = [...new Set(out.match(/https:\/\/semopenalex\.org\/[a-z]+\/[\w-]+/g) ?? [])];
    trace?.(`MCP keyword_search("${text}") → ${iris.length} entities`);
    return iris;
  }

  async describeEntity(iri: string, trace?: Trace): Promise<string> {
    const args = await this.textArgs("describe_entity", iri, /^(iri|uri|entity|id|resource)$/i);
    if (!args) return "";
    const out = await this.call<unknown>("describe_entity", args);
    trace?.(`MCP describe_entity(<${iri}>)`);
    if (out == null) return "";
    return typeof out === "string" ? out : JSON.stringify(out);
  }
}

/**
 * Authorization header for the MCP server: SEMOPENALEX_MCP_AUTH is the full
 * header value (e.g. "Basic …" from the challenge's connector config);
 * SEMOPENALEX_MCP_KEY is "user:password" (Basic) or a bearer token.
 */
function mcpAuthorization(): string | null {
  const strip = (v?: string) => v?.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim() || undefined;
  const auth = strip(process.env.SEMOPENALEX_MCP_AUTH);
  if (auth) return auth;
  const key = strip(process.env.SEMOPENALEX_MCP_KEY);
  if (!key) return null;
  return key.includes(":") ? `Basic ${Buffer.from(key).toString("base64")}` : `Bearer ${key}`;
}

let mcp: McpSource | null = null;

export function mcpEnabled() {
  return mcpAuthorization() !== null;
}

/** Live check for the status page: one entity_lookup round trip. */
export async function mcpCheck(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  if (!mcpEnabled()) return { ok: false, ms: 0 };
  try {
    const hits = await (getSource() as McpSource).lookupConcept("Alzheimer");
    return { ok: hits.length > 0, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: (err as Error).message.slice(0, 200) };
  }
}

/** The only knowledge-graph source: the SemOpenAlex MCP server. */
export function getSource(): ScholarlySource {
  if (!mcpEnabled()) {
    throw new Error("SemOpenAlex MCP credentials missing – set SEMOPENALEX_MCP_AUTH or SEMOPENALEX_MCP_KEY. Einstein only queries SemOpenAlex through its MCP server.");
  }
  return (mcp ??= new McpSource());
}
