import "server-only";
import type { Concept, ConceptCount, Work, YearCount, YearSeries } from "@/lib/types";
import { SparqlTimeout, type ScholarlySource } from "./source";

// SPARQL templates against the SemOpenAlex ontology (ontology/einstein.ttl –
// the source refuses terms it does not define). Every number shown in the UI
// comes from one of these queries, never from the LLM.

const PREFIXES = `PREFIX soa: <https://semopenalex.org/ontology/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX fabio: <http://purl.org/spar/fabio/>
PREFIX prism: <http://prismstandard.org/namespaces/basic/2.0/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX org: <http://www.w3.org/ns/org#>
PREFIX bido: <http://purl.org/spar/bido/>
`;

export const LAST_INDEXED_YEAR = 2025; // SemOpenAlex snapshot – later years are nearly empty

const lit = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/[\r\n]/g, " ")}"`;
const iri = (u: string) => {
  if (!/^https?:\/\/[^\s<>"{}|\\^`]+$/.test(u)) throw new Error(`Invalid IRI: ${u}`);
  return `<${u}>`;
};

/**
 * Work belongs to every given concept. Kept as plain triple patterns: the
 * endpoint times out (~10 s) on VALUES/UNION over large concepts, so callers
 * run one query per method concept in parallel and merge.
 */
function scope(concepts: Concept[], yearFrom?: number) {
  const t = concepts.map((c) => `?w soa:hasConcept ${iri(c.uri)} .`).join("\n  ");
  const y = yearFrom ? `FILTER(?year >= ${Math.floor(yearFrom)})` : "";
  return `${t}\n  ?w fabio:hasPublicationYear ?year . ${y}`;
}

/** Work → author: the direct dct:creator link, or via the soa:Authorship node. */
export type AuthorPath = "creator" | "authorship";
const AUTHOR_PATH: Record<AuthorPath, string> = {
  creator: "?w dct:creator ?a .",
  authorship: "?w soa:hasAuthorship ?as . ?as soa:hasAuthor ?a .",
};

export const queries = {
  /**
   * Concepts whose label is exactly one of the given spellings. A label lookup,
   * not a scan: a CONTAINS filter over every concept label made the MCP server
   * lose its connection pool ("Connection pool shut down").
   */
  conceptsByLabel(labels: string[]) {
    const values = labels.flatMap((l) => [lit(l), `${lit(l)}@en`]).join(" ");
    return `${PREFIXES}SELECT ?c ?l ?n WHERE {
  VALUES ?l { ${values} }
  ?c skos:prefLabel ?l ; a soa:Concept .
  OPTIONAL { ?c soa:worksCount ?n }
} LIMIT 10`;
  },
  conceptsByIri(uris: string[]) {
    return `${PREFIXES}SELECT ?c ?l ?n WHERE {
  VALUES ?c { ${uris.map(iri).join(" ")} }
  ?c a soa:Concept ; skos:prefLabel ?l .
  OPTIONAL { ?c soa:worksCount ?n }
} ORDER BY DESC(?n)`;
  },
  topWorks(concepts: Concept[], yearFrom: number | undefined, limit: number) {
    return `${PREFIXES}SELECT ?w ?title ?year ?cites WHERE {
  ${scope(concepts, yearFrom)}
  ?w soa:citedByCount ?cites .
  OPTIONAL { ?w dct:title ?title }
} ORDER BY DESC(?cites) LIMIT ${limit}`;
  },
  perYear(concepts: Concept[], yearFrom?: number) {
    return `${PREFIXES}SELECT ?year (COUNT(?w) AS ?n) WHERE {
  ${scope(concepts, yearFrom)}
} GROUP BY ?year ORDER BY ?year`;
  },
  coConcepts(concepts: Concept[], yearFrom?: number) {
    return `${PREFIXES}SELECT ?c ?l (COUNT(?w) AS ?n) WHERE {
  ${scope(concepts, yearFrom)}
  ?w soa:hasConcept ?c . ?c skos:prefLabel ?l ; soa:level ?lvl .
  # level 0 = whole disciplines; C2779134260 = generic "Disease"
  FILTER(?lvl >= 1 && ?c != <https://semopenalex.org/concept/C2779134260>)
} GROUP BY ?c ?l ORDER BY DESC(?n) LIMIT 30`;
  },
  /** Cheap fallback: no ORDER BY, only works above a citation threshold. */
  sampleWorks(concepts: Concept[], yearFrom: number | undefined, minCites: number, limit: number) {
    return `${PREFIXES}SELECT ?w ?year ?cites WHERE {
  ${scope(concepts, yearFrom)}
  ?w soa:citedByCount ?cites . FILTER(?cites >= ${Math.floor(minCites)})
} LIMIT ${limit}`;
  },
  countInYear(concepts: Concept[], year: number) {
    const t = concepts.map((c) => `?w soa:hasConcept ${iri(c.uri)} .`).join("\n  ");
    return `${PREFIXES}SELECT (COUNT(?w) AS ?n) WHERE {
  ${t}
  ?w fabio:hasPublicationYear ${Math.floor(year)} .
}`;
  },
  details(works: string[]) {
    return `${PREFIXES}SELECT ?w ?title ?abstract ?doi WHERE {
  VALUES ?w { ${works.map(iri).join(" ")} }
  OPTIONAL { ?w dct:title ?title }
  OPTIONAL { ?w dct:abstract ?abstract }
  OPTIONAL { ?w prism:doi ?doi }
}`;
  },
  titles(works: string[]) {
    return `${PREFIXES}SELECT ?w ?title WHERE {
  VALUES ?w { ${works.map(iri).join(" ")} }
  ?w dct:title ?title .
}`;
  },
  /** Authors per work – used to skip consortium papers before listing their authors. */
  authorCounts(works: string[], path: AuthorPath = "creator") {
    return `${PREFIXES}SELECT ?w (COUNT(DISTINCT ?a) AS ?n) WHERE {
  VALUES ?w { ${works.map(iri).join(" ")} }
  ${AUTHOR_PATH[path]}
} GROUP BY ?w
LIMIT ${works.length}`;
  },
  workAuthors(works: string[], path: AuthorPath = "creator") {
    return `${PREFIXES}SELECT DISTINCT ?w ?a WHERE {
  VALUES ?w { ${works.map(iri).join(" ")} }
  ${AUTHOR_PATH[path]}
}`;
  },
  authorNames(authors: string[]) {
    return `${PREFIXES}SELECT ?a ?name WHERE {
  VALUES ?a { ${authors.map(iri).join(" ")} }
  ?a foaf:name ?name .
}`;
  },
  /**
   * Works, citations and citations per year of age within the run's scope
   * (topic, any of the methods, year filter), per author ?g. Anchored on the
   * authors, so the UNION stays cheap.
   */
  authorTopicStats(groups: [string, string][], topics: Concept[], methods: Concept[], yearFrom?: number, path: AuthorPath = "creator") {
    const m = methods.map((c) => `{ ?w soa:hasConcept ${iri(c.uri)} }`).join(" UNION ");
    const now = LAST_INDEXED_YEAR + 1;
    return `${PREFIXES}SELECT ?g (COUNT(?w) AS ?n) (SUM(?cites) AS ?c) (SUM(?cites / IF(?year >= ${LAST_INDEXED_YEAR}, 1, ${now} - ?year)) AS ?cpy) WHERE {
  { SELECT DISTINCT ?g ?w ?cites ?year WHERE {
    VALUES (?a ?g) { ${groups.map(([a, g]) => `(${iri(a)} ${lit(g)})`).join(" ")} }
    ${AUTHOR_PATH[path]}
    ${scope(topics, yearFrom)}
    ${m}
    ?w soa:citedByCount ?cites .
  } }
} GROUP BY ?g
LIMIT ${new Set(groups.map(([, g]) => g)).size}`;
  },
  authorDetails(authors: string[]) {
    return `${PREFIXES}SELECT ?a ?name ?h ?inst WHERE {
  VALUES ?a { ${authors.map(iri).join(" ")} }
  ?a foaf:name ?name .
  OPTIONAL { ?a bido:h-index ?h }
  OPTIONAL { ?a org:memberOf ?i . ?i foaf:name ?inst }
}`;
  },
  workConcepts(works: string[], minLevel = 2) {
    return `${PREFIXES}SELECT ?w ?c ?l WHERE {
  VALUES ?w { ${works.map(iri).join(" ")} }
  ?w soa:hasConcept ?c . ?c skos:prefLabel ?l ; soa:level ?lvl . FILTER(?lvl >= ${minLevel})
}`;
  },
};

/** Words that never name a concept on their own. */
const VAGUE = /^(research|study|studies|analysis|method|methods|approach|approaches|based|using|application|applications|scientific|science|recent|new|modern|role|use|impact|effect|effects|design|development|data|model|models|system|systems)$/i;

/** Shorter phrases of a term to link when the whole term has no concept – longest first, head noun (last word) first. */
function subPhrases(term: string) {
  const words = term.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  const out: string[] = [];
  for (let n = words.length - 1; n >= 1; n--) {
    for (let i = words.length - n; i >= 0; i--) {
      const w = words.slice(i, i + n);
      if (n === 1 && (w[0].length < 4 || VAGUE.test(w[0]))) continue;
      out.push(w.join(" "));
    }
  }
  return out.slice(0, 4);
}

/** Spellings of a label as OpenAlex might store it ("deep learning" → "Deep learning", "Deep Learning" …). */
function spellings(term: string) {
  const t = term.trim();
  const lower = t.toLowerCase();
  return [...new Set([t, lower, lower.replace(/^\p{L}/u, (c) => c.toUpperCase()), lower.replace(/\b\p{L}/gu, (c) => c.toUpperCase())])];
}

/** Same concept label up to case, apostrophes, hyphens and a plural ending ("Graph neural networks" = "Graph neural network"). */
function sameLabel(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[\s-]+/g, " ").trim();
  const [x, y] = [n(a), n(b)];
  const plural = (one: string, many: string) => many === `${one}s` || many === `${one}es`;
  return x === y || plural(x, y) || plural(y, x);
}

export async function findConcept(src: ScholarlySource, term: string): Promise<Concept | null> {
  // 1. The MCP server's entity linking on the whole term.
  const link = async (t: string) => {
    if (!src.lookupConcept) return null;
    const hits = await src.lookupConcept(t).catch(() => []);
    if (!hits.length) return null;
    // An exact label wins unless it is a tiny niche concept next to a broad one.
    const broadest = [...hits].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))[0];
    const exact = hits.find((h) => sameLabel(h.label, t));
    const h = exact && (exact.rank ?? 0) >= 0.1 * (broadest.rank ?? 0) ? exact : broadest;
    return { uri: h.iri, label: h.label, worksCount: h.rank };
  };
  const linked = await link(term);
  if (linked) return linked;
  // 2. Its keyword search, then 3. an exact label lookup (cheap, unlike a label scan).
  let rows: Record<string, string>[] = [];
  if (src.keywordSearch) {
    const uris = (await src.keywordSearch(term).catch(() => [])).filter((u) => u.includes("semopenalex.org/concept/")).slice(0, 10);
    if (uris.length) rows = await src.runSparql(queries.conceptsByIri(uris)).catch(() => []);
  }
  if (!rows.length) rows = await src.runSparql(queries.conceptsByLabel(spellings(term))).catch(() => []);
  if (rows.length) {
    // Prefer an exact label match, otherwise the most used concept.
    const exact = rows.find((r) => sameLabel(r.l, term));
    const r = exact ?? [...rows].sort((a, b) => Number(b.n ?? 0) - Number(a.n ?? 0))[0];
    return { uri: r.c, label: r.l, worksCount: r.n ? Number(r.n) : undefined };
  }
  // 4. Terms the planner made up ("Scientific biography") – link a shorter phrase ("biography").
  for (const p of subPhrases(term)) {
    const c = await link(p);
    if (c) return c;
  }
  return null;
}

/** One query per method (or just the topic when there are none), merged. */
function perMethod<T>(topics: Concept[], methods: Concept[], run: (concepts: Concept[], method?: Concept) => Promise<T>) {
  return methods.length
    ? Promise.all(methods.map((m) => run([...topics, m], m)))
    : Promise.all([run(topics)]);
}

/** Notes about approximations, surfaced in the agent trace. */
export type Note = (message: string) => void;

/** Highly cited works without ORDER BY: lower the citation bar until enough turn up. */
async function sampleWorks(src: ScholarlySource, concepts: Concept[], yearFrom: number | undefined, want: number) {
  let rows: Record<string, string>[] = [];
  for (const min of [200, 50, 10, 0]) {
    // A failed lower bar must not throw away what a higher one already found.
    const next = await src.runSparql(queries.sampleWorks(concepts, yearFrom, min, 300)).catch(() => []);
    if (next.length > rows.length) rows = next;
    if (rows.length >= want) break;
  }
  return rows;
}

export async function topWorks(
  src: ScholarlySource,
  topics: Concept[],
  methods: Concept[],
  yearFrom: number | undefined,
  limit = 20,
  note: Note = () => {},
): Promise<Work[]> {
  const lists = await perMethod(topics, methods, async (c) => {
    try {
      return await src.runSparql(queries.topWorks(c, yearFrom, limit));
    } catch (err) {
      if (!(err instanceof SparqlTimeout)) throw err;
      note(`${c.map((x) => x.label).join(" × ")}: ranking timed out, sampled highly cited works instead`);
      return sampleWorks(src, c, yearFrom, limit);
    }
  });
  const byUri = new Map<string, Work>();
  for (const r of lists.flat()) {
    byUri.set(r.w, { uri: r.w, title: r.title || "", year: Number(r.year), cites: Number(r.cites) });
  }
  return [...byUri.values()].sort((a, b) => b.cites - a.cites).slice(0, limit);
}

export async function perYear(src: ScholarlySource, topics: Concept[], methods: Concept[], yearFrom?: number, note: Note = () => {}): Promise<YearSeries[]> {
  return perMethod(topics, methods, async (c, m) => {
    const label = m?.label ?? topics.map((t) => t.label).join(" + ");
    let data: YearCount[];
    try {
      const rows = await src.runSparql(queries.perYear(c, yearFrom));
      data = rows.map((r) => ({ year: Number(r.year), n: Number(r.n) }));
    } catch (err) {
      if (!(err instanceof SparqlTimeout)) throw err;
      // One count per year is much cheaper than GROUP BY over the whole set.
      const from = Math.max(yearFrom ?? LAST_INDEXED_YEAR - 5, LAST_INDEXED_YEAR - 7);
      const years = Array.from({ length: LAST_INDEXED_YEAR - from + 1 }, (_, i) => from + i);
      const counts = await Promise.all(
        years.map((y) => src.runSparql(queries.countInYear(c, y)).then((r) => ({ year: y, n: Number(r[0]?.n ?? 0) })).catch(() => null)),
      );
      data = counts.filter((d): d is YearCount => d !== null);
      note(`${label}: counted per year (${data.length}/${years.length} years answered in time)`);
    }
    return { label, data: data.filter((r) => r.year <= LAST_INDEXED_YEAR + 1).sort((a, b) => a.year - b.year) };
  });
}

export async function coConcepts(src: ScholarlySource, topics: Concept[], methods: Concept[], yearFrom?: number, note: Note = () => {}): Promise<ConceptCount[]> {
  const skip = new Set([...topics, ...methods].map((c) => c.uri));
  const lists = await perMethod(topics, methods, async (c) => {
    try {
      return await src.runSparql(queries.coConcepts(c, yearFrom));
    } catch (err) {
      if (!(err instanceof SparqlTimeout)) throw err;
      // Count co-occurrences in a sample of works instead of the full set.
      const sample = (await src.runSparql(queries.sampleWorks(c, yearFrom, 0, 150)).catch(() => [])).map((r) => r.w);
      if (!sample.length) return [];
      // In batches: 150 works carry more concept rows than one paged query returns.
      const rows = await inBatches(sample, 8, (b) => src.runSparql(queries.workConcepts(b, 1)));
      note(`${c.map((x) => x.label).join(" × ")}: co-occurrence counted in a sample of ${sample.length} works`);
      const n = new Map<string, { c: string; l: string; n: number }>();
      for (const r of rows) {
        if (r.c === "https://semopenalex.org/concept/C2779134260") continue;
        const cur = n.get(r.c) ?? { c: r.c, l: r.l, n: 0 };
        cur.n += 1;
        n.set(r.c, cur);
      }
      return [...n.values()].map((x) => ({ c: x.c, l: x.l, n: String(x.n) }));
    }
  });
  // A work tagged with several method concepts counts once per method subset.
  const merged = new Map<string, ConceptCount>();
  for (const r of lists.flat()) {
    if (skip.has(r.c)) continue;
    const cur = merged.get(r.c) ?? { uri: r.c, label: r.l, n: 0 };
    cur.n += Number(r.n);
    merged.set(r.c, cur);
  }
  return [...merged.values()].sort((a, b) => b.n - a.n).slice(0, 20);
}

/** Batches sent to the MCP server at once – more only queue up there and time out. */
const BATCH_CONCURRENCY = 6;

/**
 * Runs a per-works query in batches, a few at a time. A failed batch is retried
 * one work at a time, and a work that still fails is left out instead of
 * failing the run; `onError` hears about each one left out.
 */
export async function inBatches(uris: string[], size: number, run: (batch: string[]) => Promise<Record<string, string>[]>, onError?: (err: Error) => void) {
  const batches: string[][] = [];
  for (let i = 0; i < uris.length; i += size) batches.push(uris.slice(i, i + size));
  const one = (b: string[]) =>
    run(b).catch((err: Error) => {
      if (b.length === 1) {
        onError?.(err);
        return [];
      }
      return Promise.all(b.map((u) => run([u]).catch((e: Error) => (onError?.(e), [])))).then((r) => r.flat());
    });
  const rows: Record<string, string>[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      rows[i] = await one(batches[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, worker));
  return rows.flat();
}

export async function enrichWorks(src: ScholarlySource, works: Work[]) {
  if (!works.length) return { works, concepts: new Map<string, Concept[]>() };
  const uris = works.map((w) => w.uri);
  // Abstracts are long: the MCP server gives up on answers with many of them,
  // so they are fetched a few works at a time.
  const [details, conceptRows] = await Promise.all([
    inBatches(uris, 4, (b) => src.runSparql(queries.details(b))),
    inBatches(uris, 8, (b) => src.runSparql(queries.workConcepts(b))),
  ]);
  const byUri = new Map(details.map((r) => [r.w, r]));
  const concepts = new Map<string, Concept[]>();
  for (const r of conceptRows) {
    const list = concepts.get(r.w) ?? [];
    list.push({ uri: r.c, label: r.l });
    concepts.set(r.w, list);
  }
  return {
    works: works.map((w) => ({
      ...w,
      title: w.title || byUri.get(w.uri)?.title || w.uri,
      abstract: byUri.get(w.uri)?.abstract,
      doi: byUri.get(w.uri)?.doi,
    })),
    concepts,
  };
}
