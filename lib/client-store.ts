import type { AgentEvent, ExplainLevel, ResearchResult } from "./types";

// Conversations live in this browser; storage may be unavailable (private
// mode), so every access is guarded.

const KEY = "einstein:chats";
const MAX = 30;

export interface Turn {
  question: string;
  trace: AgentEvent[];
  result?: ResearchResult;
  error?: string;
  /** Re-tellings of the result for an audience, created on demand. */
  explanations?: { level: ExplainLevel; text: string }[];
  /** SemOpenAlex failed: ask whether to search the web instead. */
  offerWeb?: boolean;
  /** The answer comes from the web-search fallback, not from SemOpenAlex. */
  web?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  turns: Turn[];
}

export function listChats(): Conversation[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Conversation[];
  } catch {
    return [];
  }
}

export function loadChat(id: string): Conversation | null {
  return listChats().find((c) => c.id === id) ?? null;
}

export function saveChat(c: Conversation) {
  try {
    const all = [c, ...listChats().filter((x) => x.id !== c.id)];
    // Drop the oldest chats when the quota is hit.
    for (let n = Math.min(all.length, MAX); n > 0; n--) {
      try {
        localStorage.setItem(KEY, JSON.stringify(all.slice(0, n)));
        break;
      } catch {
        /* try with fewer */
      }
    }
    window.dispatchEvent(new Event("einstein:chats"));
  } catch {
    /* disabled – the chat stays visible in the current tab */
  }
}

export function deleteChat(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listChats().filter((c) => c.id !== id)));
    window.dispatchEvent(new Event("einstein:chats"));
  } catch {
    /* ignore */
  }
}
