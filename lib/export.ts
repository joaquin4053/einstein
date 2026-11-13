import { DataFactory, Writer } from "n3";
import type { ResearchResult } from "./types";

const { namedNode, literal, quad } = DataFactory;
const EIN = "https://einstein.app/kg/";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const PROV = "http://www.w3.org/ns/prov#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const SOA = "https://semopenalex.org/ontology/";

export const runIri = (r: Pick<ResearchResult, "id">) => `${EIN}run/${r.id}`;

// Labels for Einstein's own classes and predicates, so metaphactory shows names.
const VOCAB: [string, string, string][] = [
  ["ResearchRun", "Class", "Research run"],
  ["Claim", "Class", "Claim"],
  ["Method", "Class", "Method"],
  ["Task", "Class", "Task"],
  ["Topic", "Class", "Topic"],
  ["Concept", "Class", "Concept"],
  ["Work", "Class", "Paper"],
  ["appliedTo", "Property", "applied to"],
  ["uses", "Property", "uses"],
  ["addresses", "Property", "addresses"],
  ["about", "Property", "about"],
  ["coOccursWith", "Property", "co-occurs with"],
  ["hasClaim", "Property", "has claim"],
  ["question", "Property", "question"],
  ["confidence", "Property", "confidence"],
  ["verdict", "Property", "verdict"],
];

/** Evidence graph as Turtle – nodes reuse SemOpenAlex IRIs where they exist. */
export function toTurtle(r: ResearchResult): string {
  const w = new Writer({ prefixes: { ein: EIN, rdfs: RDFS, prov: PROV, soa: SOA } });
  const iri = new Map(r.nodes.map((n) => [n.id, n.uri ?? `${EIN}${n.id.replace(":", "/")}`]));
  const kindClass: Record<string, string> = { work: "Work", method: "Method", task: "Task", concept: "Concept", topic: "Topic" };
  // The SemOpenAlex class each kind maps onto (ontology/einstein.ttl).
  const soaClass: Record<string, string> = { work: "Work", concept: "Concept", topic: "Concept" };
  const title = new Map(r.works.map((x) => [x.uri, x.title]));
  const run = namedNode(runIri(r));
  for (const [name, kind, label] of VOCAB) {
    w.addQuad(quad(namedNode(`${EIN}${name}`), namedNode(`${RDF}type`), namedNode(kind === "Class" ? "http://www.w3.org/2002/07/owl#Class" : `${RDF}Property`)));
    w.addQuad(quad(namedNode(`${EIN}${name}`), namedNode(`${RDFS}label`), literal(label)));
  }
  w.addQuad(quad(run, namedNode(`${RDF}type`), namedNode(`${EIN}ResearchRun`)));
  w.addQuad(quad(run, namedNode(`${RDFS}label`), literal(r.question)));
  w.addQuad(quad(run, namedNode(`${EIN}question`), literal(r.question)));
  w.addQuad(quad(run, namedNode("http://purl.org/dc/terms/created"), literal(r.createdAt, namedNode(`${XSD}dateTime`))));
  for (const t of r.topics) if (t.uri) w.addQuad(quad(run, namedNode(`${EIN}about`), namedNode(t.uri)));
  for (const n of r.nodes) {
    w.addQuad(quad(namedNode(iri.get(n.id)!), namedNode(`${RDF}type`), namedNode(`${EIN}${kindClass[n.kind]}`)));
    // Only SemOpenAlex resources get a soa: class (web-fallback papers are not in the KG).
    if (n.uri?.startsWith("https://semopenalex.org/") && soaClass[n.kind]) w.addQuad(quad(namedNode(n.uri), namedNode(`${RDF}type`), namedNode(`${SOA}${soaClass[n.kind]}`)));
    w.addQuad(quad(namedNode(iri.get(n.id)!), namedNode(`${RDFS}label`), literal((n.uri && title.get(n.uri)) || n.label)));
  }
  r.edges.forEach((e, i) => {
    const s = namedNode(iri.get(e.source)!);
    const p = namedNode(`${EIN}${e.predicate}`);
    const o = namedNode(iri.get(e.target)!);
    w.addQuad(quad(s, p, o));
    // Reified statement carrying provenance (which works support the edge).
    const st = namedNode(`${EIN}run/${r.id}/edge/${i}`);
    w.addQuad(quad(st, namedNode(`${RDF}subject`), s));
    w.addQuad(quad(st, namedNode(`${RDF}predicate`), p));
    w.addQuad(quad(st, namedNode(`${RDF}object`), o));
    for (const ev of e.evidence) w.addQuad(quad(st, namedNode(`${PROV}wasDerivedFrom`), namedNode(ev)));
  });
  r.claims.forEach((c) => {
    const cn = namedNode(`${EIN}run/${r.id}/claim/${c.id}`);
    w.addQuad(quad(run, namedNode(`${EIN}hasClaim`), cn));
    w.addQuad(quad(cn, namedNode(`${RDF}type`), namedNode(`${EIN}Claim`)));
    w.addQuad(quad(cn, namedNode(`${RDFS}label`), literal(c.text)));
    w.addQuad(quad(cn, namedNode(`${EIN}confidence`), literal(String(c.confidence), namedNode(`${XSD}decimal`))));
    w.addQuad(quad(cn, namedNode(`${EIN}verdict`), literal(c.verdict)));
    for (const s of c.sources) w.addQuad(quad(cn, namedNode(`${PROV}wasDerivedFrom`), namedNode(s)));
  });
  let out = "";
  w.end((_err, res) => (out = res ?? ""));
  return out;
}

export function toMarkdown(r: ResearchResult): string {
  const byUri = new Map(r.works.map((w) => [w.uri, w]));
  const claims = r.claims
    .map((c) => {
      const src = c.sources.map((u) => byUri.get(u)).filter(Boolean).map((w) => `  - ${w!.title} (${w!.year}) ${w!.doi ?? w!.uri}`);
      return [`- **[${c.id}] ${c.text}**`, ...src].join("\n");
    })
    .join("\n");
  return `# ${r.question}\n\n_Einstein · ${new Date(r.createdAt).toLocaleString()} · LLM: ${r.mode.llm} · Source: ${r.mode.source}_\n\n${r.report}\n\n## Claims & evidence\n\n${claims}\n`;
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
