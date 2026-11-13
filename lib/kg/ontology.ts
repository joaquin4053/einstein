import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Parser } from "n3";

// ontology/einstein.ttl (Einstein's terms + the complete SemOpenAlex ontology)
// is the vocabulary of every SPARQL query and of the agents' prompts. Queries
// that use a class or property it does not define are refused.

const FILE = path.join(process.cwd(), "ontology", "einstein.ttl");
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";

export const NS: Record<string, string> = {
  ein: "https://einstein.app/kg/",
  soa: "https://semopenalex.org/ontology/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dct: "http://purl.org/dc/terms/",
  fabio: "http://purl.org/spar/fabio/",
  prism: "http://prismstandard.org/namespaces/basic/2.0/",
  prov: "http://www.w3.org/ns/prov#",
  foaf: "http://xmlns.com/foaf/0.1/",
  org: "http://www.w3.org/ns/org#",
  bido: "http://purl.org/spar/bido/",
};

interface Ontology {
  /** label and comment of every term the file defines */
  terms: Map<string, { label?: string; comment?: string }>;
}

/** Resources (works, concepts, runs …), not vocabulary – allowed as full IRIs. */
const DATA = /^https:\/\/(semopenalex\.org\/(?!ontology\/)|einstein\.app\/kg\/run\/)/;

let cached: Ontology | null | undefined;

function load(): Ontology | null {
  if (cached !== undefined) return cached;
  try {
    const terms: Ontology["terms"] = new Map();
    for (const q of new Parser().parse(readFileSync(FILE, "utf8"))) {
      if (q.subject.termType !== "NamedNode") continue;
      const t = terms.get(q.subject.value) ?? {};
      if (q.predicate.value === `${RDFS}label`) t.label ??= q.object.value;
      if (q.predicate.value === `${RDFS}comment`) t.comment ??= q.object.value;
      terms.set(q.subject.value, t);
    }
    cached = { terms };
  } catch (err) {
    console.warn(`Ontology not loaded from ${FILE}: ${(err as Error).message}`);
    cached = null;
  }
  return cached;
}

/** IRIs a query uses (prefixed names expanded, literals ignored). */
function iris(query: string): string[] {
  const prefixes = new Map([...query.matchAll(/PREFIX\s+(\w*):\s*<([^>]+)>/gi)].map((m) => [m[1], m[2]]));
  const body = query.replace(/PREFIX\s+\w*:\s*<[^>]+>/gi, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const prefixed = [...body.matchAll(/(?<![\w?$])(\w+):([\w-]+)/g)]
    .filter((m) => prefixes.has(m[1]))
    .map((m) => prefixes.get(m[1]) + m[2]);
  const full = [...body.matchAll(/<([^>\s]+)>/g)].map((m) => m[1]);
  return [...new Set([...prefixed, ...full])];
}

export class OntologyError extends Error {}

/** Throws when a query uses a class or property the ontology does not define. */
export function checkQuery(query: string) {
  const o = load();
  if (!o) return;
  const unknown = iris(query).filter((iri) => !o.terms.has(iri) && !DATA.test(iri));
  if (unknown.length) throw new OntologyError(`Query uses terms outside the ontology: ${unknown.join(", ")}`);
}

const short = (iri: string) => {
  const [p, ns] = Object.entries(NS).find(([, ns]) => iri.startsWith(ns)) ?? [];
  return p ? `${p}:${iri.slice(ns!.length)}` : `<${iri}>`;
};

/** The SemOpenAlex terms the pipeline queries, besides Einstein's own. */
const QUERIED = ["soa:Work", "soa:Concept", "soa:hasConcept", "soa:level", "soa:worksCount", "soa:citedByCount", "skos:prefLabel", "fabio:hasPublicationYear", "dct:title", "dct:abstract", "prism:doi", "soa:Author", "dct:creator", "foaf:name", "bido:h-index", "org:memberOf"];

/** Compact description of the ontology for the agents' system prompts. */
export function ontologyBrief(): string {
  const o = load();
  const line = (iri: string) => {
    const t = o?.terms.get(iri);
    return `- ${short(iri)}${t?.label ? ` (${t.label})` : ""}${t?.comment ? `: ${t.comment}` : ""}`;
  };
  const ein = o ? [...o.terms.keys()].filter((i) => i.startsWith(NS.ein) && i !== `${NS.ein}ontology`) : [];
  const soa = QUERIED.map((q) => NS[q.split(":")[0]] + q.split(":")[1]);
  return [
    "SemOpenAlex ontology terms used for retrieval:",
    ...soa.map(line),
    "Einstein ontology terms for the evidence graph (mapped onto SemOpenAlex):",
    ...ein.map(line),
  ].join("\n");
}
