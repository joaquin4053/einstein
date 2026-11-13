import { notFound } from "next/navigation";
import { Chat } from "@/components/Chat";

// "/" and "/c/<id>" share one route so the chat stays mounted (and keeps
// streaming) when a new conversation's URL is set.
export default async function ChatPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  if (slug.length && !(slug.length === 2 && slug[0] === "c")) notFound();
  return <Chat id={slug[1]} />;
}
