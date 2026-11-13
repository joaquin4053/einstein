import "server-only";
import { complete, llmStatus } from "@/lib/llm";

export const MAX_SENTENCES = 5;

/** Keeps at most `n` sentences – the LLM does not always stick to the limit. */
export function firstSentences(text: string, n = MAX_SENTENCES): string {
  // Split after . ! ? followed by a space and a capital letter, so "0.95" or "e.g. this" stay intact.
  return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[\p{Lu}\d"“(])/u).slice(0, n).join(" ");
}

export interface SummaryInput {
  title: string;
  abstract: string;
  year?: number;
  question?: string;
}

/**
 * Short plain-language summary of one paper from its abstract. Without an LLM,
 * the abstract's first sentences stand in for it.
 */
export async function summarize({ title, abstract, year, question }: SummaryInput): Promise<{ text: string; by: "llm" | "abstract" }> {
  if (!llmStatus().enabled) return { text: firstSentences(abstract), by: "abstract" };
  const text = await complete(
    `You summarise scientific papers for a research assistant. Write at most ${MAX_SENTENCES} short, plain sentences: what the paper studies, how, and what it finds. ` +
      "Use only the given title and abstract – never invent results, numbers or methods. " +
      "Write in the language of the user's question if one is given, otherwise in English. Plain text, no markdown, no lists.",
    `${question ? `User's question: ${question}\n\n` : ""}Title: ${title}${year ? ` (${year})` : ""}\n\nAbstract:\n${abstract}`,
    300,
  );
  if (!text) throw new Error("The LLM returned an empty summary.");
  return { text: firstSentences(text), by: "llm" };
}
