// Checks whether the SemOpenAlex MCP server answers – the same calls Einstein makes.
// SEMOPENALEX_MCP_AUTH="Basic …" npm run check:mcp   (or put it in .env.local)
// Third check: do works link to authors via dct:creator (what the author analysis relies on)?
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*(SEMOPENALEX_MCP_\w+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env.local */
}

const url = process.env.SEMOPENALEX_MCP_URL || "https://semopenalex.org/mcp";
const key = process.env.SEMOPENALEX_MCP_KEY;
const auth = process.env.SEMOPENALEX_MCP_AUTH || (key && (key.includes(":") ? `Basic ${Buffer.from(key).toString("base64")}` : `Bearer ${key}`));
if (!auth) {
  console.error("Set SEMOPENALEX_MCP_AUTH (\"Basic …\") or SEMOPENALEX_MCP_KEY first.");
  process.exit(2);
}

const client = new Client({ name: "einstein-check", version: "0.1.0" });
/** `expect` must occur in the answer – an empty result counts as a failure too. */
const call = async (name, args, expect) => {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(text);
    const ok = !res.isError && parsed.success && parsed.output != null && JSON.stringify(parsed.output).includes(expect);
    console.log(`${ok ? "OK  " : "FAIL"} ${name} (${Date.now() - t0} ms): ${ok ? JSON.stringify(parsed.output).slice(0, 200) : parsed.message ?? "no output (timeout)"}`);
    return ok;
  } catch (err) {
    console.log(`FAIL ${name} (${Date.now() - t0} ms): ${err.message}`);
    return false;
  }
};

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: auth } } }));
  console.log(`Connected to ${url} – tools: ${(await client.listTools()).tools.map((t) => t.name).join(", ")}`);
} catch (err) {
  console.log(`FAIL connect: ${err.message}`);
  process.exit(1);
}
const results = [
  await call("entity_lookup", { text: "Machine learning", candidateTypes: ["https://semopenalex.org/ontology/Concept"] }, "semopenalex.org/concept/"),
  await call("execute_sparql_query", { query: "SELECT ?c WHERE { ?c a <https://semopenalex.org/ontology/Concept> } LIMIT 1" }, "semopenalex.org/concept/"),
  await call("execute_sparql_query", {
    query: "SELECT ?a WHERE { ?w <https://semopenalex.org/ontology/hasConcept> <https://semopenalex.org/concept/C119857082> ; <http://purl.org/dc/terms/creator> ?a } LIMIT 3",
  }, "semopenalex.org/author/"),
];
await client.close();
console.log(results.every(Boolean) ? "\nThe MCP server works." : "\nThe MCP server has problems – see the FAIL lines above.");
process.exit(results.every(Boolean) ? 0 : 1);
