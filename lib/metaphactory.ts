import "server-only";

// Local metaphactory + GraphDB (docker compose, see README). Einstein writes each
// run's evidence graph into its own named graph of metaphactory's repository.
// Only reachable where the containers run – unset on Vercel.

export function metaphactoryStatus() {
  return {
    enabled: Boolean(process.env.METAPHACTORY_GRAPHDB_URL),
    url: process.env.METAPHACTORY_URL || "http://localhost:10214",
    graphdb: process.env.METAPHACTORY_GRAPHDB_URL || "",
  };
}

export async function metaphactoryReachable(): Promise<boolean> {
  const { enabled, graphdb } = metaphactoryStatus();
  if (!enabled) return false;
  return fetch(`${graphdb}/size`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
}

/** Replaces the named graph `graph` with the given Turtle (Graph Store protocol). */
export async function putGraph(graph: string, turtle: string) {
  const { graphdb } = metaphactoryStatus();
  const res = await fetch(`${graphdb}/rdf-graphs/service?graph=${encodeURIComponent(graph)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/turtle; charset=utf-8" },
    body: turtle,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GraphDB ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export function resourceUrl(iri: string) {
  return `${metaphactoryStatus().url}/resource/?uri=${encodeURIComponent(iri)}`;
}
