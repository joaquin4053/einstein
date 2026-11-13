// Shared types between the agent pipeline (server) and the UI (client).

export type AgentId =
  | "planner"
  | "retriever"
  | "extractor"
  | "graph"
  | "verifier"
  | "reporter"
  | "authors";

export const AGENTS: { id: AgentId; name: string; role: string }[] = [
  { id: "planner", name: "Planner", role: "Breaks the question down and maps terms to KG concepts" },
  { id: "retriever", name: "Retriever", role: "Queries SemOpenAlex for works, trends and co-occurring concepts" },
  { id: "extractor", name: "Extractor", role: "Reads abstracts and extracts method → task relations" },
  { id: "graph", name: "Graph Builder", role: "Builds the evidence knowledge graph with provenance" },
  { id: "verifier", name: "Verifier", role: "Advocate vs. skeptic debate, scores every claim" },
  { id: "reporter", name: "Reporter", role: "Writes the evidence-grounded report" },
  { id: "authors", name: "Author Analyst", role: "Ranks the authors who contributed most to the topic (after the answer)" },
];

export interface Concept {
  uri: string;
  label: string;
  worksCount?: number;
}

export interface Work {
  uri: string;
  title: string;
  year: number;
  cites: number;
  doi?: string;
  abstract?: string;
}

export type NodeKind = "work" | "method" | "task" | "concept" | "topic";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  uri?: string;
  weight: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  /** Works (URIs) that support this edge. */
  evidence: string[];
}

export interface Debate {
  advocate: string;
  skeptic: string;
  verdict: string;
}

export type Verdict = "supported" | "weak" | "rejected";

export interface Claim {
  id: string;
  text: string;
  /** Edge ids in the evidence graph this claim rests on. */
  edgeIds: string[];
  sources: string[];
  confidence: number;
  verdict: Verdict;
  debate: Debate;
}

export interface YearCount {
  year: number;
  n: number;
}

export interface YearSeries {
  label: string;
  data: YearCount[];
}

export interface ConceptCount {
  uri: string;
  label: string;
  n: number;
}

/**
 * Links to an author's profiles. The SemOpenAlex IRI opens the author in the
 * SemOpenAlex Explorer; Google Scholar and LinkedIn are reserved for later.
 */
export interface ProfileLinks {
  semOpenAlex: string;
  googleScholar?: string;
  linkedIn?: string;
}

/** One SemOpenAlex author – its IRI is the identity; authors are never merged by name. */
export interface TopicAuthor {
  /** SemOpenAlex author IRI. */
  uri: string;
  name: string;
  institution?: string;
  /** Works on the topic (the run's scope) and their citations, counted in the KG. */
  works: number;
  cites: number;
  /** Citations divided by each work's age in years, summed. */
  citesPerYear: number;
  hIndex?: number;
  /** 0–1 relevance score for the topic, see lib/config/authors.ts. Computed per run, not stored in the evidence graph. */
  score: number;
  /** Works the answer read (the run's works) and works its claims cite, written by this author. */
  answerWorks?: number;
  claimWorks?: number;
  /** 0–1: contribution to this answer blended with the topic score, relative to the strongest author – the bubble size. */
  contribution?: number;
  /** This author's part of all listed authors' contribution (the shares add up to 1). */
  share?: number;
  /** Median publication year of the author's works in the sample – newer authors sit closer to the centre. */
  year?: number;
  /** The author's most cited works in the run's sample. */
  topWorks: { uri: string; title: string; year: number; cites: number }[];
  /** Most frequent co-authors on the sampled works, with the number of shared works. */
  coAuthors: { uri: string; name: string; shared: number }[];
  profileLinks: ProfileLinks;
}

export interface AuthorAnalysis {
  /** The central node: what the counts refer to, e.g. "Alzheimer's disease × Deep learning". */
  topic: string;
  sampleWorks: number;
  candidates: number;
  authors: TopicAuthor[];
  /** Key authors who wrote sampled works together (drawn between their bubbles). */
  links: { source: string; target: string; shared: number }[];
  /** True when some counts come from the sample only (topic-wide query timed out). */
  approximate?: boolean;
  /** Set when topic × methods had too few key authors and the topic alone was used. */
  widened?: boolean;
  /** Shown by default; the rest behind "show all". */
  topN: number;
  /** What the analysis had to work around (timeouts, failed queries, widening) – shown when nothing is found. */
  notes?: string[];
}

export interface Plan {
  /** The question translated to English by the Planner (LLM mode only). */
  questionEn?: string;
  topicTerms: string[];
  methodTerms: string[];
  yearFrom?: number;
  subquestions: string[];
}

export type ExplainLevel = "child" | "teen" | "adult" | "expert";

export interface ResearchResult {
  id: string;
  question: string;
  createdAt: string;
  mode: { llm: string; source: string };
  plan: Plan;
  topics: Concept[];
  methods: Concept[];
  works: Work[];
  perYear: YearSeries[];
  coConcepts: ConceptCount[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  claims: Claim[];
  report: string;
  /** Arrives after the answer (an "authors" event); missing in runs saved before it existed. */
  authors?: AuthorAnalysis;
  /** The year filter the retrieval ended up with (it may have widened the planner's). */
  yearFrom?: number;
  /** Agent events, attached in the browser so a saved run can replay its trace. */
  trace?: AgentEvent[];
}

export type AgentEvent =
  | { type: "run"; id: string; question: string; mode: { llm: string; source: string } }
  | { type: "agent_start"; agent: AgentId; message: string }
  | { type: "agent_done"; agent: AgentId; message: string }
  | { type: "tool_call"; agent: AgentId; tool: string; detail: string; ms?: number }
  | { type: "log"; agent: AgentId; message: string }
  /** offerWeb: SemOpenAlex failed – the UI asks whether to search the web instead. */
  | { type: "error"; agent?: AgentId; message: string; offerWeb?: boolean }
  | { type: "result"; result: ResearchResult }
  | { type: "authors"; authors: AuthorAnalysis };
