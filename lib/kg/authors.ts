import "server-only";
import { AUTHOR_CONFIG as CFG } from "@/lib/config/authors";
import type { AuthorAnalysis, Concept, TopicAuthor, Work } from "@/lib/types";
import { SparqlTimeout, type ScholarlySource } from "./source";
import { LAST_INDEXED_YEAR, inBatches, queries, topWorks, type AuthorPath, type Note } from "./queries";

// Key authors of a run's scope: candidates from the most cited works, ranked by
// their topic-wide works, citations per year and h-index, with their co-authors.
// Everything comes from SemOpenAlex through its MCP server. The score is computed
// at run time and cached here – it is never written to a graph.

/** One SemOpenAlex author (its IRI is the identity, as in the SemOpenAlex Explorer). */
interface Identity {
  key: string;
  iris: string[];
  /** Works of the sample, each once. */
  works: Map<string, Work>;
}

interface Stats {
  works: number;
  cites: number;
  perYear: number;
}

const cache = new Map<string, { at: number; value: AuthorAnalysis }>();

const norm = (v: number, max: number) => (max > 0 ? Math.log1p(v) / Math.log1p(max) : 0);
const age = (w: Work) => (w.year >= LAST_INDEXED_YEAR ? 1 : LAST_INDEXED_YEAR + 1 - w.year);

/**
 * Topic-wide statistics per identity. A batch that fails, times out or answers
 * with no row at all is left out – its authors keep their sample counts.
 */
async function topicStats(src: ScholarlySource, ids: Identity[], topics: Concept[], methods: Concept[], yearFrom: number | undefined, path: AuthorPath, note: Note) {
  const out = new Map<string, Stats>();
  let failed = 0;
  let error = "";
  const batches: Identity[][] = [];
  for (let i = 0; i < ids.length; i += 8) batches.push(ids.slice(i, i + 8));
  await Promise.all(
    batches.map(async (b) => {
      try {
        const pairs = b.flatMap((id) => id.iris.map((a) => [a, id.key] as [string, string]));
        const rows = await src.runSparql(queries.authorTopicStats(pairs, topics, methods, yearFrom, path));
        // Every author has at least one work in the scope (the sample one), so no row at all means the query failed quietly.
        if (!rows.length) throw new Error("no rows");
        for (const r of rows) out.set(r.g, { works: Number(r.n) || 0, cites: Number(r.c) || 0, perYear: Number(r.cpy) || 0 });
      } catch (err) {
        failed += b.length;
        error ||= err instanceof SparqlTimeout ? "timed out" : (err as Error).message;
      }
    }),
  );
  if (failed) note(`Topic-wide counts missing for ${failed}/${ids.length} candidates (${error.slice(0, 120)}) – using their works in the sample`);
  return { out, complete: !failed };
}

/** The works behind one answer: what the run read, and which of them its claims cite. */
export interface AnswerWorks {
  works: Work[];
  claimWorks: string[];
}

export async function keyAuthors(
  src: ScholarlySource,
  topics: Concept[],
  methods: Concept[],
  yearFrom: number | undefined,
  note: Note = () => {},
  answer: AnswerWorks = { works: [], claimWorks: [] },
): Promise<AuthorAnalysis> {
  const key = [...topics.map((c) => c.uri), "|", ...methods.map((c) => c.uri), "|", yearFrom ?? "", "|", ...answer.works.map((w) => w.uri).sort(), "|", ...[...answer.claimWorks].sort()].join(" ");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CFG.cacheTtlMs) {
    note("Author ranking served from cache");
    return hit.value;
  }
  const notes: string[] = [];
  const value = await analyse(src, topics, methods, yearFrom, (m) => (notes.push(m), note(m)), answer);
  value.notes = notes;
  // Empty or partial results may come from dropped queries – try again next time.
  if (!value.authors.length || value.approximate) return value;
  if (cache.size >= CFG.cacheEntries) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Collects the queries a step left out, for one note per step. */
function failures(step: string, note: Note) {
  let n = 0;
  let first = "";
  return {
    onError: (err: Error) => {
      n++;
      first ||= err instanceof SparqlTimeout ? "timed out" : err.message;
    },
    report: () => n && note(`${step}: ${n} queries failed (${first.slice(0, 120)})`),
  };
}

async function analyse(src: ScholarlySource, topics: Concept[], methods: Concept[], yearFrom: number | undefined, note: Note, answer: AnswerWorks): Promise<AuthorAnalysis> {
  const label = [...topics, ...methods].map((c) => c.label).join(" × ");
  // The answer's own works always belong to the sample, so their authors are found.
  const top = await topWorks(src, topics, methods, yearFrom, CFG.sampleWorks, note);
  const works = [...new Map([...answer.works, ...top].map((w) => [w.uri, w])).values()];
  const inAnswer = new Set(answer.works.map((w) => w.uri));
  const inClaims = new Set(answer.claimWorks);
  // claimWorks lists a work once per claim that cites it.
  const claimsCiting = new Map<string, number>();
  for (const u of answer.claimWorks) claimsCiting.set(u, (claimsCiting.get(u) ?? 0) + 1);
  const byUri = new Map(works.map((w) => [w.uri, w]));
  const empty = (candidates = 0): AuthorAnalysis => ({ topic: label, sampleWorks: works.length, candidates, authors: [], links: [], topN: CFG.topN });
  if (!works.length) {
    note("No works found for the author sample");
    return empty();
  }

  // 1. Authors of the sampled works, consortium papers left out. Works link to
  //    authors directly (dct:creator); the Authorship nodes are the fallback.
  let path: AuthorPath = "creator";
  const authorsOf = async (p: AuthorPath) => {
    const f = failures(`authors per work (${p})`, note);
    const counts = await inBatches(works.map((w) => w.uri), 20, (b) => src.runSparql(queries.authorCounts(b, p)), f.onError);
    const small = counts.filter((r) => Number(r.n) <= CFG.maxAuthorsPerWork).map((r) => r.w);
    if (small.length < counts.length) note(`${counts.length - small.length} works with more than ${CFG.maxAuthorsPerWork} authors left out of the author sample`);
    const rows = await inBatches(small, 5, (b) => src.runSparql(queries.workAuthors(b, p)), f.onError);
    f.report();
    return rows;
  };
  let authorRows = await authorsOf(path);
  if (!authorRows.length) {
    note("No authors via dct:creator – trying soa:hasAuthorship");
    path = "authorship";
    authorRows = await authorsOf(path);
  }
  if (!authorRows.length) {
    note(`No authors found for the ${works.length} sampled works`);
    return empty();
  }

  // 2. One identity per SemOpenAlex author IRI, as in the SemOpenAlex Explorer – never merged by name.
  const ids = new Map<string, Identity>();
  const authorsOfWork = new Map<string, string[]>();
  for (const r of authorRows) {
    const id: Identity = ids.get(r.a) ?? { key: r.a, iris: [r.a], works: new Map() };
    const w = byUri.get(r.w);
    if (w) id.works.set(w.uri, w);
    ids.set(r.a, id);
    authorsOfWork.set(r.w, [...(authorsOfWork.get(r.w) ?? []), r.a]);
  }

  const sum = (id: Identity) => [...id.works.values()].reduce((s, w) => s + w.cites, 0);
  const C = CFG.contribution;
  // Fractional credit: a work's worth is shared by all its authors.
  const answerShare = (id: Identity) => {
    let n = 0;
    for (const u of id.works.keys()) {
      if (!inAnswer.has(u)) continue;
      n += (C.answerWork + C.claimWork * (claimsCiting.get(u) ?? 0)) / Math.max(1, new Set(authorsOfWork.get(u)).size);
    }
    return n;
  };
  // Authors of the answer's works first, then the most prolific in the sample.
  const candidates = [...ids.values()]
    .sort((a, b) => answerShare(b) - answerShare(a) || b.works.size - a.works.size || sum(b) - sum(a))
    .slice(0, CFG.candidates);

  // 3. Topic-wide statistics and profile data for the candidates.
  const fd = failures("author details", note);
  const [stats, details] = await Promise.all([
    topicStats(src, candidates, topics, methods, yearFrom, path, note),
    inBatches(candidates.flatMap((c) => c.iris), 10, (b) => src.runSparql(queries.authorDetails(b)), fd.onError),
  ]);
  fd.report();
  const info = new Map<string, Record<string, string>[]>();
  for (const r of details) info.set(r.a, [...(info.get(r.a) ?? []), r]);

  // 4. Score, filter, rank. The sample is a lower bound for the topic-wide counts.
  const rows = candidates.map((id) => {
    const sample = [...id.works.values()];
    const own = { works: sample.length, cites: sum(id), perYear: sample.reduce((x, w) => x + w.cites / age(w), 0) };
    const kg = stats.out.get(id.key);
    const d = info.get(id.key) ?? [];
    const hs = d.map((r) => Number(r.h)).filter((h) => Number.isFinite(h) && h > 0);
    return {
      id,
      counted: Boolean(kg),
      works: Math.max(own.works, kg?.works ?? 0),
      cites: Math.max(own.cites, kg?.cites ?? 0),
      perYear: Math.max(own.perYear, kg?.perYear ?? 0),
      uri: id.key,
      name: d.find((r) => r.name)?.name,
      institution: d.find((r) => r.inst)?.inst,
      hIndex: hs.length ? Math.max(...hs) : undefined,
      sample,
    };
  });
  const max = {
    works: Math.max(0, ...rows.map((r) => r.works)),
    perYear: Math.max(0, ...rows.map((r) => r.perYear)),
    h: Math.max(0, ...rows.map((r) => r.hIndex ?? 0)),
  };
  const W = CFG.weights;
  const scored = rows.map((r) => ({
    ...r,
    score: Math.round((W.works * norm(r.works, max.works) + W.citationsPerYear * norm(r.perYear, max.perYear) + W.hIndex * (max.h ? (r.hIndex ?? 0) / max.h : 0)) * 100) / 100,
  }));
  // Without topic-wide counts, one work among the most cited ones already counts.
  const ranked = scored
    .map((r) => ({ ...r, share: answerShare(r.id) }))
    .map((r, _, all) => {
      const maxShare = Math.max(0, ...all.map((x) => x.share));
      const c = r.share > 0 && maxShare ? (r.share / maxShare) * (1 - C.topicWeight + C.topicWeight * r.score) : C.outsideAnswer * r.score;
      return { ...r, contribution: Math.round(c * 1000) / 1000 };
    })
    .filter((r) => r.share > 0 || (r.works >= (r.counted ? CFG.minTopicWorks : 1) && r.score >= CFG.minScore))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, CFG.maxN);
  if (!ranked.length) {
    note(`None of ${candidates.length} candidates has ${CFG.minTopicWorks}+ works on the topic and a score of ${CFG.minScore}+`);
    return empty(candidates.length);
  }

  // 5. Co-authors: who wrote the sampled works together with each key author.
  const coCount = ranked.map((r) => {
    const n = new Map<string, number>();
    for (const w of r.sample) for (const a of authorsOfWork.get(w.uri) ?? []) if (a !== r.uri) n.set(a, (n.get(a) ?? 0) + 1);
    return [...n.entries()].sort((x, y) => y[1] - x[1]).slice(0, CFG.coAuthorsPerAuthor);
  });
  const keyNames = new Map(ranked.map((r) => [r.uri, r.name]));
  const unnamed = [...new Set(coCount.flat().map(([a]) => a).filter((a) => !keyNames.get(a) && !info.has(a)))];
  const fn = failures("co-author names", note);
  const names = new Map((await inBatches(unnamed, 20, (b) => src.runSparql(queries.authorNames(b)), fn.onError)).map((r) => [r.a, r.name]));
  fn.report();
  const nameOf = (a: string) => keyNames.get(a) ?? info.get(a)?.find((r) => r.name)?.name ?? names.get(a) ?? `Author ${a.split("/").pop()}`;
  // Key authors who share sampled works, counted per pair.
  const keySet = new Set(ranked.map((r) => r.uri));
  const pairs = new Map<string, number>();
  for (const as of authorsOfWork.values()) {
    const keys = [...new Set(as.filter((a) => keySet.has(a)))].sort();
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) pairs.set(`${keys[i]} ${keys[j]}`, (pairs.get(`${keys[i]} ${keys[j]}`) ?? 0) + 1);
  }
  const links = [...pairs].map(([k, shared]) => ({ source: k.split(" ")[0], target: k.split(" ")[1], shared }));

  const total = ranked.reduce((s, r) => s + r.contribution, 0) || 1;

  // Titles are missing when topWorks fell back to sampling.
  const shown = ranked.map((r) => [...r.sample].sort((x, y) => Number(inAnswer.has(y.uri)) - Number(inAnswer.has(x.uri)) || y.cites - x.cites).slice(0, CFG.topWorksPerAuthor));
  const untitled = [...new Set(shown.flat().filter((w) => !w.title).map((w) => w.uri))];
  const titles = new Map((untitled.length ? await inBatches(untitled, 10, (b) => src.runSparql(queries.titles(b))) : []).map((r) => [r.w, r.title]));

  const authors: TopicAuthor[] = ranked.map((r, i) => ({
    uri: r.uri,
    name: r.name ?? `Author ${r.uri.split("/").pop()}`,
    institution: r.institution,
    works: r.works,
    cites: r.cites,
    citesPerYear: Math.round(r.perYear * 10) / 10,
    hIndex: r.hIndex,
    score: r.score,
    answerWorks: [...r.id.works.keys()].filter((u) => inAnswer.has(u)).length,
    claimWorks: [...r.id.works.keys()].filter((u) => inClaims.has(u)).length,
    contribution: r.contribution,
    share: Math.round((r.contribution / total) * 1000) / 1000,
    year: median(r.sample.map((w) => w.year).filter((y) => y > 0)),
    topWorks: shown[i].map((w) => ({ uri: w.uri, title: w.title || titles.get(w.uri) || "", year: w.year, cites: w.cites })),
    coAuthors: coCount[i].map(([a, shared]) => ({ uri: a, name: nameOf(a), shared })),
    // The SemOpenAlex IRI opens the author in the SemOpenAlex Explorer; the others are reserved for later.
    profileLinks: { semOpenAlex: r.uri },
  }));
  return { topic: label, sampleWorks: works.length, candidates: candidates.length, authors, links, topN: CFG.topN, approximate: !stats.complete || undefined };
}

function median(xs: number[]) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}
