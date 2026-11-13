import "server-only";
import { complete } from "@/lib/llm";
import type { Claim, ExplainLevel } from "@/lib/types";

export const EXPLAIN_LEVELS: ExplainLevel[] = ["child", "teen", "adult", "expert"];

const STYLE: Record<ExplainLevel, string> = {
  child: "a curious 8-year-old: short sentences, everyday comparisons, no technical terms",
  teen: "a high-school student: plain language, introduce at most a few technical terms and explain each one",
  adult: "an interested adult without a science background: clear and concrete, technical terms only when explained",
  expert: "a researcher in the field: compact and precise, technical terms are fine",
};

export interface ExplainInput {
  question: string;
  level: ExplainLevel;
  report: string;
  claims: Pick<Claim, "id" | "text" | "verdict">[];
  topics: string[];
}

/** Re-tells a finished research result for a given audience, in the language of the question. */
export function explain({ question, level, report, claims, topics }: ExplainInput): Promise<string> {
  const facts = claims.map((c) => `[${c.id}] (${c.verdict}) ${c.text}`).join("\n");
  return complete(
    `You are the Explainer agent of a scholarly research assistant. Explain a finished research result for ${STYLE[level]}. ` +
      "Write in the language of the original question (e.g. German question → German answer). " +
      "Use simple markdown (## headings, short paragraphs, bullet points). " +
      "First explain what the topic is about in general – this basic background may come from your own knowledge. " +
      "Then explain what the research found, based only on the report and claims; cite claims inline as [C1], [C2] and never invent numbers or papers. " +
      "End with one sentence saying which part is general background knowledge and which part comes from the analysed papers.",
    `Original question: ${question}\nTopic concepts: ${topics.join(", ") || "–"}\n\nClaims:\n${facts || "–"}\n\nResearch report:\n${report}`,
  );
}
