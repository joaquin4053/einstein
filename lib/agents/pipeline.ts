import "server-only";
import { complete, completeJson, llmStatus, resolveModel } from "@/lib/llm";
import { getSource, type ScholarlySource } from "@/lib/kg/source";
import { searchPapersOnWeb, webSearchEnabled } from "@/lib/web/openai-search";
import { ontologyBrief } from "@/lib/kg/ontology";
import { coConcepts, enrichWorks, findConcept, perYear, topWorks } from "@/lib/kg/queries";
import { keyAuthors, type AnswerWorks } from "@/lib/kg/authors";
import { AUTHOR_CONFIG } from "@/lib/config/authors";
import type {
  AgentEvent,
  AgentId,
  AuthorAnalysis,
  Claim,
  Concept,
  Debate,
  GraphEdge,
  GraphNode,
  Plan,
  ResearchResult,
  Verdict,
  Work,
  YearSeries,
} from "@/lib/types";
import { GENERIC_METHOD_TERMS, METHOD_NAMES, METHOD_PATTERNS, STOPWORDS, TASK_NAMES, TASK_PATTERNS, canonical, matchAll } from "./lexicon";

type Emit = (e: AgentEvent) => void;

// ── Small helpers ──────────────────────────────────────────────────────────

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const uniqBy = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
/** Lower-cases a label for use mid-sentence, keeping acronyms such as "MRI" or "EEG". */
const lower = (s = "") => (/^\p{Lu}{2}/u.test(s) ? s : s.replace(/^\p{Lu}/u, (c) => c.toLowerCase()));

/**
 * Times one retrieval step and records the SPARQL sent through `src` so the UI
 * can show it. The step is labelled with the MCP tools it actually called.
 */
async function traced<T>(emit: Emit, agent: AgentId, step: string, label: string, src: ScholarlySource, fn: (s: ScholarlySource) => Promise<T>): Promise<T> {
  const sent: string[] = [];
  const used = new Set<string>();
  const note = (line: string) => sent.push(line);
  const via = <A extends unknown[], R>(tool: string, f: (...a: A) => R) => (...a: A) => (used.add(tool), f(...a));
  const rec: ScholarlySource = {
    name: src.name,
    viaMcp: src.viaMcp,
    runSparql: via("execute_sparql_query", (q: string) => (sent.push(q), src.runSparql(q, note))),
    lookupConcept: src.lookupConcept && via("entity_lookup", (t: string) => src.lookupConcept!(t, note)),
    keywordSearch: src.keywordSearch && via("keyword_search", (t: string) => src.keywordSearch!(t, note)),
    describeEntity: src.describeEntity && via("describe_entity", (i: string) => src.describeEntity!(i, note)),
  };
  const t0 = Date.now();
  const tool = () => (src.viaMcp ? `mcp:${[...used].join(" + ") || "–"}` : "sparql");
  const detail = () => [`${step}: ${label}`, ...sent].join("\n\n");
  try {
    const out = await fn(rec);
    emit({ type: "tool_call", agent, tool: tool(), detail: detail(), ms: Date.now() - t0 });
    return out;
  } catch (err) {
    emit({ type: "tool_call", agent, tool: tool(), detail: `${detail()}\n\n-- failed: ${(err as Error).message}`, ms: Date.now() - t0 });
    throw err;
  }
}

/**
 * Rules every LLM agent gets in its system prompt: SemOpenAlex only through its
 * MCP server, and the ontology first – every entity and relation in its terms.
 */
const KG_RULES = `RULES – follow them in every step:
1. Data source: the SemOpenAlex knowledge graph, accessed only through the SemOpenAlex MCP server and its tools execute_sparql_query, entity_lookup, keyword_search and describe_entity. Use no other tool, endpoint, website, search engine or API, and do not suggest one.
2. Ontology first: before you name, map or relate anything, look it up in the ontology below and use only its classes and properties. Papers are soa:Work, research topics and fields are soa:Concept (with their skos:prefLabel as in OpenAlex), extracted methods are ein:Method, tasks are ein:Task, and a method used for a task is ein:appliedTo.
3. Evidence only: every statement must come from the data you are given, which was retrieved through the MCP server. Do not add facts, numbers or papers from your own knowledge.`;

let kgContext: string | undefined;
function withKg(prompt: string) {
  kgContext ??= `${KG_RULES}\n\nONTOLOGY (ontology/einstein.ttl):\n${ontologyBrief()}`;
  return `${prompt}\n\n${kgContext}`;
}

/** Runs the LLM path when a key is configured, else (or on failure) the rule-based one. */
async function withLlm<T>(emit: Emit, agent: AgentId, llm: () => Promise<T>, rules: () => T | Promise<T>): Promise<T> {
  if (!llmStatus().enabled) return rules();
  try {
    return await llm();
  } catch (err) {
    emit({ type: "log", agent, message: `LLM step failed, using rule-based fallback: ${(err as Error).message}` });
    return rules();
  }
}

// ── 1. Planner ─────────────────────────────────────────────────────────────

function rulePlan(question: string): Plan {
  const year = question.match(/\b(?:since|after|from|starting)\s+((?:19|20)\d{2})\b/i)?.[1] ?? question.match(/\b((?:19|20)\d{2})\b/)?.[1];
  let rest = question.replace(/[’']s\b/g, "");
  const methodTerms: string[] = [];
  for (const [re, terms] of GENERIC_METHOD_TERMS) {
    if (re.test(rest)) {
      methodTerms.push(...terms);
      rest = rest.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  const words = rest
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
  // Capitalised words are usually the domain (Alzheimer, COVID, Parkinson …).
  const capital = words.filter((w) => /^\p{Lu}/u.test(w));
  const topicTerms = uniq(capital.length ? capital : words).slice(0, 2);
  return {
    topicTerms,
    methodTerms: uniq(methodTerms).slice(0, 3),
    yearFrom: year ? Number(year) : undefined,
    subquestions: [
      `Which ${methodTerms.length ? "AI methods" : "approaches"} appear in ${topicTerms.join(" / ") || "the field"} research${year ? ` since ${year}` : ""}?`,
      "Which tasks are they applied to, and how strong is the evidence?",
      "Which related concepts and subfields co-occur most often?",
      "How has publication activity developed over time?",
    ],
  };
}

async function planner(question: string, emit: Emit): Promise<Plan> {
  emit({ type: "agent_start", agent: "planner", message: "Decomposing the question" });
  const plan = await withLlm(
    emit,
    "planner",
    async () => {
      const p = await completeJson<Plan>(
        withKg("You are the Planner agent of a scholarly research assistant working on the SemOpenAlex knowledge graph. First map the question onto the ontology: the research domain and the methods are soa:Concept. topicTerms and methodTerms must therefore be soa:Concept labels as they appear in OpenAlex (e.g. \"Alzheimer's disease\", \"Machine learning\", \"Deep learning\"), so the MCP tool entity_lookup can link them. Concept labels are English only: whatever language the question is in, always give English labels (e.g. \"Relativitätstheorie\" → \"Theory of relativity\"). Prefer short, established concept labels over made-up compound phrases (e.g. \"Cattle\" and \"Greenhouse gas\" rather than \"Cattle farming\" and \"CO2 emissions\")."),
        `Question: ${question}\n\nReturn {"questionEn": the question in English (unchanged if already English), "topicTerms": [1-2 short English concept labels for the research domain], "methodTerms": [0-3 short English concept labels for methods/technologies], "yearFrom": number or null, "subquestions": [3-4 sub-questions in English]}.`,
      );
      if (!p.topicTerms?.length) throw new Error("no topic terms");
      // Methods named in the question itself (e.g. "deep learning") always count,
      // even when the LLM files them under topics or picks narrower terms.
      const rules = rulePlan(p.questionEn?.trim() || question);
      const methodTerms = uniq([...rules.methodTerms, ...(p.methodTerms ?? [])]).slice(0, 4);
      const topicTerms = p.topicTerms.filter((t) => !methodTerms.some((m) => m.toLowerCase() === t.toLowerCase()));
      return { ...rules, ...p, questionEn: p.questionEn?.trim() || undefined, topicTerms: topicTerms.length ? topicTerms : p.topicTerms, methodTerms, yearFrom: p.yearFrom ?? undefined };
    },
    () => rulePlan(question),
  );
  emit({
    type: "log",
    agent: "planner",
    message: `Topic: ${plan.topicTerms.join(", ")} · Methods: ${plan.methodTerms.join(", ") || "–"} · From: ${plan.yearFrom ?? "any year"}`,
  });
  emit({ type: "agent_done", agent: "planner", message: `${plan.subquestions.length} sub-questions` });
  return plan;
}

// ── 2. Retriever ───────────────────────────────────────────────────────────

/** Method concepts below this size make the topic × method intersection nearly empty. */
const MIN_METHOD_WORKS = 2000;

async function retriever(question: string, plan: Plan, src: ScholarlySource, emit: Emit) {
  emit({ type: "agent_start", agent: "retriever", message: `Querying ${src.name}` });
  // A failed lookup (MCP error, timeout) must not look like "no such concept".
  const failures: string[] = [];
  const resolve = (terms: string[]) =>
    Promise.all(
      terms.map((t) =>
        traced(emit, "retriever", "concept", `"${t}"`, src, (s) => findConcept(s, t)).catch((err) => (failures.push((err as Error).message), null)),
      ),
    ).then((cs) => cs.filter((c): c is Concept => Boolean(c)));

  const [direct, resolved] = await Promise.all([resolve(plan.topicTerms), resolve(plan.methodTerms)]);
  // Terms may still miss the English-only labels (rule-based plan, odd LLM
  // wording): ask once for English concept labels before giving up.
  // When every lookup failed, retrying other terms only fails again.
  const allFailed = failures.length >= plan.topicTerms.length + plan.methodTerms.length;
  const topics = direct.length || allFailed ? direct : await fallbackTopics(plan.topicTerms, question, resolve, emit);
  const topicUris = new Set(topics.map((t) => t.uri));
  // Drop duplicates of the topic, tiny concepts, and ones dwarfed by a broader
  // method (they only add near-empty subsets and slow queries).
  const largest = Math.max(0, ...resolved.map((m) => m.worksCount ?? 0));
  let methods = uniqBy(resolved, (m) => m.uri).filter(
    (m) => !topicUris.has(m.uri) && (m.worksCount ?? MIN_METHOD_WORKS) >= Math.max(MIN_METHOD_WORKS, 0.1 * largest),
  );
  if (resolved.length && methods.length < resolved.length) {
    const dropped = resolved.filter((m) => !methods.includes(m)).map((m) => m.label);
    emit({ type: "log", agent: "retriever", message: `Too narrow or duplicate method concepts dropped: ${dropped.join(", ")}` });
  }
  // Planner terms too specific for the KG: fall back to the broad AI concepts.
  if (!methods.length && plan.methodTerms.length) {
    const broad = rulePlan(question).methodTerms.filter((t) => !plan.methodTerms.includes(t));
    methods = (await resolve(broad)).filter((m) => !topicUris.has(m.uri));
    if (methods.length) emit({ type: "log", agent: "retriever", message: `Using broader method concepts: ${methods.map((m) => m.label).join(", ")}` });
  }
  if (!topics.length) {
    // A failing server, not a bad term: say so instead of asking for another term.
    const down = src.outage?.();
    if (down) throw new Error(`The SemOpenAlex MCP server is not answering queries right now (“${down}”). Its operator needs to restart it – please try again later.`);
    if (failures.length) throw new Error(`The SemOpenAlex MCP server failed while looking up concepts (${failures.length} lookup${failures.length > 1 ? "s" : ""}): ${failures[0]}`);
    throw new Error(`No SemOpenAlex concept found for “${plan.topicTerms.join(", ")}”. Concept labels are English – try a more specific English domain term.`);
  }
  // Several topic concepts AND-ed together get narrow fast; keep the main one.
  const scopeTopics = topics.slice(0, 1);
  emit({
    type: "log",
    agent: "retriever",
    message: `Mapped to ${[...scopeTopics, ...methods].map((c) => `${c.label} (${c.uri.split("/").pop()})`).join(", ")}`,
  });

  const label = [...scopeTopics, ...methods].map((c) => c.label).join(" × ");
  const note = (message: string) => emit({ type: "log", agent: "retriever", message });
  const stats = (ms: Concept[], from: number | undefined, l: string) =>
    Promise.all([
      traced(emit, "retriever", "works per year", l, src, (s) => perYear(s, scopeTopics, ms, from, note)).catch(() => [] as YearSeries[]),
      traced(emit, "retriever", "co-occurring concepts", l, src, (s) => coConcepts(s, scopeTopics, ms, from, note)).catch(() => []),
    ]);
  const [works, [years0, co0]] = await Promise.all([
    traced(emit, "retriever", "top works", `${label}, most cited`, src, (s) => topWorks(s, scopeTopics, methods, plan.yearFrom, 24, note)),
    stats(methods, plan.yearFrom, label),
  ]);
  // Never end empty: widen step by step and say so.
  let found = works;
  let yearFrom = plan.yearFrom;
  let scopeMethods = methods;
  if (!found.length && yearFrom) {
    note(`No works matched since ${yearFrom} – widening to all years`);
    yearFrom = undefined;
    found = await traced(emit, "retriever", "top works", `${label}, all years`, src, (s) => topWorks(s, scopeTopics, methods, undefined, 24, note));
  }
  if (!found.length && methods.length) {
    note(`No works carry both concepts – widening to ${scopeTopics[0].label} alone`);
    yearFrom = plan.yearFrom;
    scopeMethods = [];
    found = await traced(emit, "retriever", "top works", `${scopeTopics[0].label}, most cited`, src, (s) => topWorks(s, scopeTopics, [], yearFrom, 24, note));
  }
  if (!found.length && yearFrom) {
    note(`No ${scopeTopics[0].label} works since ${yearFrom} – widening to all years`);
    yearFrom = undefined;
    found = await traced(emit, "retriever", "top works", `${scopeTopics[0].label}, all years`, src, (s) => topWorks(s, scopeTopics, [], undefined, 24, note));
  }
  // Statistics must describe the same scope as the works that were found.
  const widened = yearFrom !== plan.yearFrom || scopeMethods !== methods;
  const [years, co] = widened ? await stats(scopeMethods, yearFrom, [...scopeTopics, ...scopeMethods].map((c) => c.label).join(" × ")) : [years0, co0];
  const [enriched, topicInfo] = await Promise.all([
    traced(emit, "retriever", "abstracts and concepts", `${found.length} works`, src, (s) => enrichWorks(s, found)),
    src.describeEntity
      ? traced(emit, "retriever", "topic description", scopeTopics[0].label, src, (s) => s.describeEntity!(scopeTopics[0].uri))
          .then((t) => String(t ?? "").slice(0, 1500))
          .catch(() => "")
      : "",
  ]);
  emit({ type: "agent_done", agent: "retriever", message: `${found.length} works, ${co.length} co-occurring concepts` });
  return { topics: scopeTopics, topicInfo, methods: scopeMethods, yearFrom, works: enriched.works, workConcepts: enriched.concepts, perYear: years, coConcepts: co };
}

export const WEB_SOURCE = "ChatGPT web search";

/**
 * Fallback retriever: papers from ChatGPT's web search. Runs only when
 * SemOpenAlex failed and the user agreed to search the web (see CLAUDE.md).
 */
async function webRetriever(question: string, plan: Plan, emit: Emit): Promise<{ topic: Concept; works: Work[] }> {
  if (!webSearchEnabled()) throw new Error("The web search needs OPENAI_API_KEY.");
  emit({ type: "agent_start", agent: "retriever", message: "Searching the web with ChatGPT (fallback)" });
  const t0 = Date.now();
  const terms = [...plan.topicTerms, ...plan.methodTerms];
  let found: Awaited<ReturnType<typeof searchPapersOnWeb>>;
  try {
    found = await searchPapersOnWeb(question, terms, { yearFrom: plan.yearFrom });
  } catch (err) {
    emit({ type: "tool_call", agent: "retriever", tool: "web:openai_web_search", detail: `ChatGPT web search: ${question}\n\n-- failed: ${(err as Error).message}`, ms: Date.now() - t0 });
    throw err;
  }
  const { works, queries, unverified } = found;
  const detail = [`ChatGPT web search: ${question}`, ...queries.map((q) => `web_search("${q}")`), `-- ${works.length} papers${unverified ? `, ${unverified} dropped (no matching search result)` : ""}`];
  emit({ type: "tool_call", agent: "retriever", tool: "web:openai_web_search", detail: detail.join("\n\n"), ms: Date.now() - t0 });
  if (!works.length) throw new Error(`ChatGPT's web search found no papers for “${plan.topicTerms.join(", ")}”.`);
  emit({ type: "agent_done", agent: "retriever", message: `${works.length} papers from ChatGPT's web search` });
  return { topic: { uri: "", label: plan.topicTerms[0] ?? "Topic" }, works };
}

// ── 2b. Author Analyst ─────────────────────────────────────────────────────

/** Key authors of the retrieved scope. Never fails the run – the report does not depend on it. */
async function authorAnalyst(topics: Concept[], methods: Concept[], yearFrom: number | undefined, src: ScholarlySource, emit: Emit, answer: AnswerWorks): Promise<AuthorAnalysis> {
  const label = [...topics, ...methods].map((c) => c.label).join(" × ");
  emit({ type: "agent_start", agent: "authors", message: `Ranking authors of ${label}` });
  const note = (message: string) => emit({ type: "log", agent: "authors", message });
  try {
    let a = await traced(emit, "authors", "key authors", label, src, (s) => keyAuthors(s, topics, methods, yearFrom, note, answer));
    // The question's methods may narrow the topic too far for an author ranking.
    if (a.authors.length < AUTHOR_CONFIG.minAuthorsBeforeWidening && methods.length) {
      note(`Only ${a.authors.length} key authors for ${label} – widening to ${topics[0].label} alone`);
      const wide = await traced(emit, "authors", "key authors", topics[0].label, src, (s) => keyAuthors(s, topics.slice(0, 1), [], yearFrom, note, answer));
      if (wide.authors.length > a.authors.length) a = { ...wide, widened: true, notes: [...(a.notes ?? []), ...(wide.notes ?? [])] };
    }
    emit({ type: "agent_done", agent: "authors", message: `${a.authors.length} key authors from ${a.candidates} candidates in ${a.sampleWorks} works` });
    return a;
  } catch (err) {
    // A log, not an error event: the run goes on, and the UI would mark it as failed.
    emit({ type: "log", agent: "authors", message: `Author analysis failed: ${(err as Error).message}` });
    emit({ type: "agent_done", agent: "authors", message: "No author ranking" });
    return { topic: label, sampleWorks: 0, candidates: 0, authors: [], links: [], topN: AUTHOR_CONFIG.topN, notes: [`Author analysis failed: ${(err as Error).message}`] };
  }
}

/**
 * Topic terms that matched no concept (made-up compounds such as "Cattle
 * farming", or non-English words): first ask the LLM for established English
 * labels, then try the terms' single words ("Cattle", "emissions").
 */
async function fallbackTopics(terms: string[], question: string, resolve: (terms: string[]) => Promise<Concept[]>, emit: Emit): Promise<Concept[]> {
  if (llmStatus().enabled) {
    try {
      const p = await completeJson<{ terms: string[] }>(
        "You map research topics to concepts of the OpenAlex / SemOpenAlex knowledge graph, whose labels are English only.",
        `Question: ${question}\nTerms that matched no concept: ${terms.join(", ")}\n\nReturn {"terms": [1-3 short, established English OpenAlex concept labels (e.g. "Cattle", "Greenhouse gas"), the most specific first, then a broader parent field]}.`,
      );
      const retry = uniq((p.terms ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())).filter((t) => !terms.includes(t)).slice(0, 3);
      if (retry.length) {
        emit({ type: "log", agent: "retriever", message: `No concept for ${terms.join(", ")} – retrying with ${retry.join(", ")}` });
        const found = await resolve(retry);
        if (found.length) return found;
      }
    } catch (err) {
      emit({ type: "log", agent: "retriever", message: `Concept retry failed: ${(err as Error).message}` });
    }
  }
  const words = uniq(terms.flatMap((t) => t.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()))).filter((w) => !terms.includes(w)).slice(0, 4);
  if (!words.length) return [];
  emit({ type: "log", agent: "retriever", message: `Retrying with single words: ${words.join(", ")}` });
  return resolve(words);
}

// ── 3. Extractor ───────────────────────────────────────────────────────────

interface Extraction {
  methods: string[];
  tasks: string[];
}

// Broad KG concepts that say nothing about the task.
const GENERIC_CONCEPT =
  /^(computer science|artificial intelligence|machine learning|deep learning|data mining|pattern recognition|statistics|mathematics|algorithm|engineering|physics|biology|medicine|disease|geography|environmental science|psychology|mean squared error|accuracy|precision|recall|sensitivity|specificity|feature|set|range|scale|context|process|task|function|variable|sample|test set|training set|data set|benchmark|quality|performance|robustness)\b|\((mathematics|physics|statistics|computer science|philosophy|linguistics)\)$/i;

/**
 * Rule-based extraction: methods from the lexicon, tasks from the work's own
 * SemOpenAlex concepts (works for any domain), plus lexicon tasks named in the title.
 */
function ruleExtract(w: Work, concepts: Concept[], topic: Concept): Extraction {
  const text = `${w.title}. ${w.abstract ?? ""}`;
  const methods = matchAll(METHOD_PATTERNS, text);
  const isMethod = (label: string) => METHOD_PATTERNS.some(([m, re]) => m === label || re.test(label)) || /learning|neural|network|regression|forest|classifier/i.test(label);
  const kgTasks = concepts
    .map((c) => c.label)
    .filter((l) => l !== topic.label && !GENERIC_CONCEPT.test(l) && !isMethod(l))
    .slice(0, 3);
  return { methods, tasks: uniq([...matchAll(TASK_PATTERNS, w.title), ...kgTasks]) };
}

async function extractor(question: string, works: Work[], workConcepts: Map<string, Concept[]>, topic: Concept, topicInfo: string, emit: Emit): Promise<Map<string, Extraction>> {
  const topicNote = topicInfo ? `\n\nSemOpenAlex describe_entity for the topic ${topic.label}:\n${topicInfo}` : "";
  const rules = (w: Work) => ruleExtract(w, workConcepts.get(w.uri) ?? [], topic);
  emit({ type: "agent_start", agent: "extractor", message: `Reading ${works.length} abstracts` });
  const out = new Map<string, Extraction>();
  const batches: Work[][] = [];
  for (let i = 0; i < works.length; i += 6) batches.push(works.slice(i, i + 6));

  await Promise.all(
    batches.map(async (batch, bi) => {
      const res = await withLlm(
        emit,
        "extractor",
        async () => {
          const items = batch.map((w, i) => `[${i}] ${w.title}\n${(w.abstract ?? "").slice(0, 900)}`).join("\n\n");
          const json = await completeJson<{ i: number; methods: string[]; tasks: string[] }[]>(
            withKg(`You are the Extractor agent. From each paper (soa:Work), extract the concrete AI/computational methods used (ein:Method) and the tasks/application areas they address (ein:Task). Only extract what the text states. Use short names and reuse these whenever one fits – methods: ${METHOD_NAMES.join(", ")}; tasks: ${TASK_NAMES.join(", ")}. Do not repeat the research domain itself as a task (write "Classification", not "${topic.label} classification").${topicNote}`),
            `Research question: ${question}\n\nPapers:\n${items}\n\nReturn [{"i": index, "methods": [...], "tasks": [...]}].`,
            1200,
          );
          emit({ type: "tool_call", agent: "extractor", tool: "llm:extract", detail: `batch ${bi + 1}/${batches.length}` });
          return batch.map((w, i) => {
            const hit = json.find((j) => j.i === i);
            return hit
              ? { methods: hit.methods.map((m) => canonical(m, "method", topic.label)), tasks: hit.tasks.map((t) => canonical(t, "task", topic.label)) }
              : rules(w);
          });
        },
        () => batch.map(rules),
      );
      batch.forEach((w, i) => out.set(w.uri, { methods: uniq(res[i].methods), tasks: uniq(res[i].tasks) }));
    }),
  );
  const nRel = [...out.values()].reduce((s, e) => s + e.methods.length * e.tasks.length, 0);
  emit({ type: "agent_done", agent: "extractor", message: `${nRel} method → task mentions` });
  return out;
}

// ── 4. Graph Builder ───────────────────────────────────────────────────────

function graphBuilder(
  topic: Concept,
  works: Work[],
  extractions: Map<string, Extraction>,
  co: { uri: string; label: string; n: number }[],
  workConcepts: Map<string, Concept[]>,
  emit: Emit,
) {
  emit({ type: "agent_start", agent: "graph", message: "Building the evidence knowledge graph" });
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (id: string, label: string, kind: GraphNode["kind"], uri?: string) => {
    const n = nodes.get(id) ?? { id, label, kind, uri, weight: 0 };
    n.weight += 1;
    nodes.set(id, n);
    return n;
  };
  const edge = (source: string, target: string, predicate: string, evidence?: string) => {
    const id = `${source}|${predicate}|${target}`;
    const e = edges.get(id) ?? { id, source, target, predicate, evidence: [] };
    if (evidence && !e.evidence.includes(evidence)) e.evidence.push(evidence);
    edges.set(id, e);
    return e;
  };

  const topicId = `topic:${slug(topic.label)}`;
  node(topicId, topic.label, "topic", topic.uri || undefined);
  for (const w of works) {
    const ex = extractions.get(w.uri);
    if (!ex || (!ex.methods.length && !ex.tasks.length)) continue;
    // Web-search URLs share last segments ("…/12345/", "…/abstract") – keep them whole.
    const wid = `work:${w.uri.startsWith("https://semopenalex.org/") ? w.uri.split("/").pop() : w.uri}`;
    node(wid, w.title.length > 60 ? `${w.title.slice(0, 57)}…` : w.title, "work", w.uri);
    edge(wid, topicId, "about", w.uri);
    for (const m of ex.methods) {
      node(`method:${slug(m)}`, m, "method");
      edge(wid, `method:${slug(m)}`, "uses", w.uri);
    }
    for (const t of ex.tasks) {
      node(`task:${slug(t)}`, t, "task");
      edge(wid, `task:${slug(t)}`, "addresses", w.uri);
      for (const m of ex.methods) edge(`method:${slug(m)}`, `task:${slug(t)}`, "appliedTo", w.uri);
    }
  }
  // Top co-occurring concepts from the KG, linked to the works that carry them.
  for (const c of co.slice(0, 8)) {
    const cid = `concept:${c.uri.split("/").pop()}`;
    node(cid, c.label, "concept", c.uri);
    const e = edge(topicId, cid, "coOccursWith");
    for (const [wUri, cs] of workConcepts) if (cs.some((x) => x.uri === c.uri)) e.evidence.push(wUri);
  }
  emit({ type: "agent_done", agent: "graph", message: `${nodes.size} nodes, ${edges.size} edges` });
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ── 5. Verifier (advocate vs. skeptic) ─────────────────────────────────────

function score(sources: Work[], yearFrom?: number) {
  const s = sources.length;
  const cites = sources.reduce((a, w) => a + w.cites, 0);
  const now = new Date().getFullYear();
  const recent = s ? sources.filter((w) => w.year >= Math.max(now - 3, yearFrom ?? 0)).length / s : 0;
  const v = 0.5 * Math.min(1, s / 5) + 0.3 * Math.min(1, Math.log10(1 + cites) / 3) + 0.2 * recent;
  return Math.round(v * 100) / 100;
}

const verdictOf = (c: number): Verdict => (c >= 0.6 ? "supported" : c >= 0.35 ? "weak" : "rejected");

function ruleDebate(text: string, sources: Work[], confidence: number): Debate {
  const cites = sources.reduce((a, w) => a + w.cites, 0);
  const years = sources.map((w) => w.year);
  const span = years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "n/a";
  const top = [...sources].sort((a, b) => b.cites - a.cites)[0];
  return {
    advocate: `${sources.length} independent work(s) (${span}) state this, cited ${cites} times in total${top ? `; strongest: “${top.title}” (${top.cites} citations)` : ""}.`,
    skeptic:
      sources.length < 3
        ? `Only ${sources.length} source(s) – this could be an isolated finding. The relation is extracted from abstracts, not from full-text results.`
        : `Sources are the most-cited works only, so the sample is biased towards older, popular papers; abstracts may overstate performance.`,
    verdict: `${verdictOf(confidence)} – judged from source count, citation impact and recency.`,
  };
}

async function verifier(
  question: string,
  topic: Concept,
  works: Work[],
  edges: GraphEdge[],
  nodes: GraphNode[],
  years: YearSeries[],
  plan: Plan,
  emit: Emit,
): Promise<Claim[]> {
  emit({ type: "agent_start", agent: "verifier", message: "Verifying claims against the evidence graph" });
  const byUri = new Map(works.map((w) => [w.uri, w]));
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const candidates = edges
    .filter((e) => e.predicate === "appliedTo")
    .sort((a, b) => b.evidence.length - a.evidence.length)
    .slice(0, 8);

  const claims: Claim[] = candidates.map((e, i) => {
    const sources = e.evidence.map((u) => byUri.get(u)).filter((w): w is Work => Boolean(w));
    const text = `${label.get(e.source)} is applied to ${lower(label.get(e.target))} in ${topic.label} research.`;
    const confidence = score(sources, plan.yearFrom);
    return {
      id: `C${i + 1}`,
      text,
      // The relation plus the uses/addresses edges of its supporting works – not
      // other methods' appliedTo edges into the same task.
      edgeIds: [
        e.id,
        ...edges
          .filter((x) => (x.predicate === "uses" && x.target === e.source) || (x.predicate === "addresses" && x.target === e.target))
          .filter((x) => x.evidence.some((u) => e.evidence.includes(u)))
          .map((x) => x.id),
      ],
      sources: e.evidence,
      confidence,
      verdict: verdictOf(confidence),
      debate: ruleDebate(text, sources, confidence),
    };
  });

  // Trend claim straight from SPARQL counts – exact, not extracted. Series can
  // overlap (a work tagged with two methods), so use the largest one alone.
  const thisYear = new Date().getFullYear();
  const main = [...years].sort((a, b) => b.data.reduce((x, d) => x + d.n, 0) - a.data.reduce((x, d) => x + d.n, 0))[0];
  const ys = main?.data.filter((d) => d.year < thisYear) ?? [];
  if (ys.length >= 2) {
    const first = ys[0];
    const peak = ys.reduce((a, b) => (b.n > a.n ? b : a));
    const last = ys[ys.length - 1];
    // Without resolved methods the series is the topic itself ("X works tagged X").
    const methodPart = main.label !== topic.label ? ` tagged ${main.label}` : "";
    claims.push({
      id: `C${claims.length + 1}`,
      // "Grew" only when the peak comes after the first year.
      text:
        peak.year > first.year
          ? `${topic.label} works${methodPart} grew from ${first.n} (${first.year}) to a peak of ${peak.n} (${peak.year}).`
          : `${topic.label} works${methodPart} went from ${first.n} (${first.year}) to ${last.n} (${last.year}).`,
      edgeIds: [],
      sources: [],
      confidence: 0.95,
      verdict: "supported",
      debate: {
        advocate: "Counted directly in SemOpenAlex via SPARQL (GROUP BY publication year).",
        skeptic: "Concept tagging in OpenAlex is automatic, and the most recent years are still being indexed, so late counts are lower bounds.",
        verdict: "supported – exact KG statistic.",
      },
    });
  }

  // LLM debate for the extracted claims (the trend claim is already exact).
  if (llmStatus().enabled) {
    await Promise.all(
      claims.filter((c) => c.sources.length).slice(0, 6).map(async (c) => {
        try {
          const ev = c.sources.slice(0, 5).map((u) => byUri.get(u)).filter(Boolean).map((w) => `- ${w!.title} (${w!.year}, ${w!.cites} cit.): ${(w!.abstract ?? "").slice(0, 700)}`).join("\n");
          const d = await completeJson<Debate & { support: "supported" | "weak" | "unsupported" }>(
            withKg("You are the Verifier agent, running a debate between an Advocate and a Skeptic about a scientific claim. Ground every argument in the given evidence only. Judge the claim as: \"supported\" if at least one paper clearly shows it; \"weak\" if papers only imply it (e.g. they name the method more generally); \"unsupported\" only if no paper backs it or the evidence contradicts it. The claim is an ein:appliedTo relation between an ein:Method and an ein:Task."),
            `Question: ${question}\nClaim: ${c.text}\nEvidence (${c.sources.length} papers in total, showing up to 5):\n${ev}\n\nReturn {"advocate": "1-2 sentences", "skeptic": "1-2 sentences", "verdict": "1 sentence", "support": "supported" | "weak" | "unsupported"}.`,
            500,
          );
          emit({ type: "tool_call", agent: "verifier", tool: "llm:debate", detail: `${c.id}: ${d.support}` });
          c.debate = { advocate: d.advocate, skeptic: d.skeptic, verdict: d.verdict };
          // The LLM can only lower the evidence-based score, never raise it.
          if (d.support === "unsupported") {
            c.confidence = Math.min(c.confidence, 0.3);
            c.verdict = "rejected";
          } else if (d.support === "weak") {
            c.confidence = Math.min(c.confidence, 0.55);
            c.verdict = verdictOf(c.confidence);
          }
        } catch (err) {
          emit({ type: "log", agent: "verifier", message: `${c.id}: debate fallback (${(err as Error).message})` });
        }
      }),
    );
  }
  const ok = claims.filter((c) => c.verdict !== "rejected").length;
  emit({ type: "agent_done", agent: "verifier", message: `${ok}/${claims.length} claims hold up` });
  return claims;
}

// ── 6. Reporter ────────────────────────────────────────────────────────────

/** Two or three sentences that answer the question; the claims are listed below it in the UI. */
function ruleReport(question: string, topic: Concept, claims: Claim[], co: { label: string; n: number }[], nWorks: number, web?: string): string {
  const strong = claims.filter((c) => c.verdict === "supported" && c.sources.length);
  const weak = claims.filter((c) => c.verdict === "weak");
  const top = strong.slice(0, 2).map((c) => `${c.text.replace(/ in .* research\.$/, "")} [${c.id}]`);
  return [
    top.length
      ? `In ${topic.label} research, ${top.join("; ").replace(/^./, (x) => x.toLowerCase())}.`
      : `The ${nWorks} highly cited ${topic.label} works ${web ? `from a web search (${web})` : "in SemOpenAlex"} give no well-supported answer to “${question}”${weak.length ? `, only ${weak.length} weaker indication(s)` : ""}.`,
    co.length ? `Related concepts that co-occur most often are ${co.slice(0, 3).map((c) => c.label).join(", ")}.` : "",
    web ? `SemOpenAlex was unavailable, so these papers come from a web search (${web}).` : "",
  ].filter(Boolean).join(" ");
}

async function reporter(question: string, topic: Concept, claims: Claim[], co: { label: string; n: number }[], works: Work[], emit: Emit, web?: string) {
  emit({ type: "agent_start", agent: "reporter", message: "Writing the report" });
  const report = await withLlm(
    emit,
    "reporter",
    async () => {
      // Kept claims only: a rejected claim means "too little evidence in this
      // sample", which the LLM tends to misread as "not used in the field".
      const kept = claims.filter((c) => c.verdict !== "rejected");
      // No percentages: the model kept rephrasing the score as "X% support
      // rate". The UI shows the score as a badge next to each claim anyway.
      const facts = kept.map((c) => `[${c.id}] ${c.verdict}, ${c.sources.length ? `${c.sources.length} papers` : "exact KG statistic"}: ${c.text}`).join("\n");
      const text = await complete(
        withKg("You are the Reporter agent. Answer the question directly in 2–3 plain sentences (no headings, no bullet points, no lists) – the claims are shown to the user below your answer, so do not list them all. Name the most important findings and cite them inline as [C1], [C2]. Only use the given claims and statistics; never invent numbers or papers, never state percentages. Present weak claims as tentative."),
        `Question: ${question}\n\nClaims:\n${facts}\n(${claims.length - kept.length} further candidate claims had too little evidence in this sample and were left out.)\n\nCo-occurring concepts (paper counts): ${co.slice(0, 10).map((c) => `${c.label} (${c.n})`).join(", ")}\nWorks analysed: ${works.length}${web ? `\n\nNote: SemOpenAlex was unavailable. With the user's consent these papers come from a web search (${web}) instead of the MCP server – say so in one short sentence.` : ""}`,
        300,
      );
      if (!text) throw new Error("empty report");
      return text;
    },
    () => ruleReport(question, topic, claims, co, works.length, web),
  );
  emit({ type: "agent_done", agent: "reporter", message: "Report ready" });
  return report;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

/** SemOpenAlex could not answer – the UI then offers the web-search fallback. */
export class KgUnavailable extends Error {}

export async function runResearch(question: string, emit: Emit, opts: { source?: "kg" | "web" } = {}): Promise<ResearchResult> {
  const id = crypto.randomUUID();
  const web = opts.source === "web";
  let src: ScholarlySource | undefined;
  if (!web) {
    try {
      src = getSource(); // the SemOpenAlex MCP server – throws without credentials
    } catch (err) {
      throw new KgUnavailable((err as Error).message);
    }
  }
  const llm = llmStatus();
  const model = llm.enabled ? await resolveModel().catch(() => null) : null;
  const mode = { llm: model ?? (llm.enabled ? "rule-based (LLM unavailable)" : "demo (rule-based)"), source: src?.name ?? `${WEB_SOURCE} (web fallback)` };
  emit({ type: "run", id, question, mode });

  const plan = await planner(question, emit);
  // The KG and the report work in English; the original question is kept for display.
  const q = plan.questionEn ?? question;

  if (web) {
    const { topic, works } = await webRetriever(q, plan, emit);
    emit({ type: "agent_done", agent: "authors", message: "Skipped – needs SemOpenAlex" });
    const none = new Map<string, Concept[]>();
    const extractions = await extractor(q, works, none, topic, "", emit);
    const g = graphBuilder(topic, works, extractions, [], none, emit);
    const claims = await verifier(q, topic, works, g.edges, g.nodes, [], plan, emit);
    const report = await reporter(q, topic, claims, [], works, emit, WEB_SOURCE);
    return { id, question, createdAt: new Date().toISOString(), mode, plan, topics: [], methods: [], works, perYear: [], coConcepts: [], nodes: g.nodes, edges: g.edges, claims, report };
  }

  const r = await retriever(q, plan, src!, emit).catch((err) => {
    throw new KgUnavailable((err as Error).message);
  });
  if (!r.works.length) throw new KgUnavailable("SemOpenAlex returned no papers for this question.");
  const extractions = await extractor(q, r.works, r.workConcepts, r.topics[0], r.topicInfo, emit);
  const g = graphBuilder(r.topics[0], r.works, extractions, r.coConcepts, r.workConcepts, emit);
  const claims = await verifier(q, r.topics[0], r.works, g.edges, g.nodes, r.perYear, plan, emit);
  const report = await reporter(q, r.topics[0], claims, r.coConcepts, r.works, emit);

  return {
    id,
    question,
    createdAt: new Date().toISOString(),
    mode,
    plan,
    topics: r.topics,
    methods: r.methods,
    works: r.works,
    perYear: r.perYear,
    coConcepts: r.coConcepts,
    nodes: g.nodes,
    edges: g.edges,
    claims,
    report,
    yearFrom: r.yearFrom,
  };
}

/**
 * The author analysis for a finished run. It runs after the answer, never next
 * to the retrieval, so the MCP server never sees both heavy phases at once.
 */
export function runAuthors(r: ResearchResult, emit: Emit): Promise<AuthorAnalysis> {
  // Once per citing claim; a rejected claim did not make it into the answer.
  const claimWorks = r.claims.filter((c) => c.verdict !== "rejected").flatMap((c) => [...new Set(c.sources)]);
  return authorAnalyst(r.topics, r.methods, r.yearFrom, getSource(), emit, { works: r.works, claimWorks });
}
