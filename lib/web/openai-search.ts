import "server-only";
import OpenAI from "openai";
import type { Work } from "@/lib/types";

// Fallback paper search through ChatGPT's web search (OpenAI Responses API),
// used only when SemOpenAlex (MCP) is unavailable and the user agreed to search
// the web – see CLAUDE.md. Every returned paper must link to a page the search
// actually returned. Separate from lib/llm, which talks to the Apertus provider.

const MODEL = () => process.env.OPENAI_SEARCH_MODEL?.trim() || "gpt-5.4";
const apiKey = () => process.env.OPENAI_API_KEY?.replace(/[\s​-‍⁠﻿]/g, "") || undefined;

export function webSearchEnabled() {
  return Boolean(apiKey());
}

interface FoundPaper {
  title?: string;
  year?: number | null;
  url?: string;
  doi?: string | null;
  citations?: number | null;
  abstract?: string | null;
}

const INSTRUCTIONS = `You find research papers on the web for a scholarly research assistant. Search the web for peer-reviewed papers, preprints and reviews that answer the user's research question – prefer publisher pages, PubMed, arXiv, Semantic Scholar, Google Scholar listings and other scholarly sources over news or blogs.

Then answer with JSON only, no prose and no code fences:
{"papers": [{"title": string, "year": number, "url": string, "doi": string | null, "citations": number | null, "abstract": string}]}

Rules:
- Only list papers you found in your web search, and give "url" exactly as the URL of that search result.
- "abstract": the paper's abstract, or 2-4 sentences summarising what the search result says about the paper. Never invent findings, numbers or authors.
- "citations": only if a result states a citation count, else null. "doi": only if shown, else null.
- Up to 20 papers, most relevant and most cited first.`;

/** Strips protocol, "www.", trailing slashes and tracking parameters so URLs compare equal. */
const norm = (u: string) =>
  u.trim().replace(/(?<=[?&])utm_[^&#]*&?/g, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[/#?&]+$/, "").toLowerCase();

function parsePapers(text: string): FoundPaper[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("ChatGPT's web search returned no paper list.");
  const out = JSON.parse(text.slice(start, end + 1)) as { papers?: FoundPaper[] };
  return Array.isArray(out.papers) ? out.papers : [];
}

export async function searchPapersOnWeb(
  question: string,
  terms: string[],
  opts: { yearFrom?: number; limit?: number } = {},
): Promise<{ works: Work[]; queries: string[]; unverified: number }> {
  const client = new OpenAI({ apiKey: apiKey(), baseURL: "https://api.openai.com/v1" });
  const res = await client.responses.create(
    {
      model: MODEL(),
      instructions: INSTRUCTIONS,
      input: `Research question: ${question}\nKey concepts: ${terms.join(", ")}${opts.yearFrom ? `\nOnly papers published in ${opts.yearFrom} or later.` : ""}`,
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      max_output_tokens: 16000,
    },
    { timeout: 180_000 },
  );

  // URLs the search really returned: its sources and the answer's citations.
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of res.output) {
    if (item.type === "web_search_call" && item.action.type === "search") {
      queries.push(...(item.action.queries ?? (item.action.query ? [item.action.query] : [])));
      for (const s of item.action.sources ?? []) seen.add(norm(s.url));
    }
    if (item.type === "message") {
      for (const c of item.content) if (c.type === "output_text") for (const a of c.annotations) if (a.type === "url_citation") seen.add(norm(a.url));
    }
  }
  if (res.status === "incomplete") throw new Error(`ChatGPT's web search stopped early (${res.incomplete_details?.reason ?? "incomplete"}) – try again.`);

  const papers = parsePapers(res.output_text);
  // Drop anything not backed by a search result (no invented papers).
  const verified = papers.filter((p) => p.title && p.url && seen.has(norm(p.url)));
  const works = verified
    .filter((p) => p.year && (!opts.yearFrom || p.year >= opts.yearFrom))
    .map((p) => ({
      uri: p.url!,
      title: p.title!.trim(),
      year: p.year!,
      cites: p.citations ?? 0,
      doi: p.doi ? (p.doi.startsWith("http") ? p.doi : `https://doi.org/${p.doi.replace(/^doi:\s*/i, "")}`) : undefined,
      abstract: p.abstract?.trim() || undefined,
    }))
    .slice(0, opts.limit ?? 24);
  return { works, queries, unverified: papers.length - verified.length };
}
