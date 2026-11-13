"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageSquare, PanelLeftClose, Plus, Settings, Trash2 } from "lucide-react";
import clsx from "clsx";
import { deleteChat, listChats, type Conversation } from "@/lib/client-store";

export function Sidebar({ activeId, open, onClose, onNew }: { activeId?: string; open: boolean; onClose: () => void; onNew: () => void }) {
  const [chats, setChats] = useState<Conversation[]>([]);
  const router = useRouter();
  // On phones the sidebar covers the page – close it once a link is followed.
  const followed = () => window.innerWidth < 768 && onClose();
  // A new chat's URL is set with history.replaceState, so the router may still
  // think it is on "/" and treat a link there as a no-op: reset explicitly.
  const startNew = () => {
    onNew();
    followed();
  };

  useEffect(() => {
    const load = () => setChats(listChats());
    load();
    window.addEventListener("einstein:chats", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("einstein:chats", load);
      window.removeEventListener("storage", load);
    };
  }, []);

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} />}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-panel-2 transition-transform md:static md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full md:hidden",
        )}
      >
        <div className="flex items-center justify-between px-3 py-3">
          <Link href="/" onClick={startNew} className="flex items-center gap-2 px-1">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent font-serif text-base font-semibold text-ink">E</span>
            <span className="font-serif text-lg tracking-tight">Einstein</span>
          </Link>
          <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-line/60 hover:text-text" aria-label="Close sidebar">
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3">
          <Link href="/" onClick={startNew} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm shadow-sm hover:border-accent hover:text-accent">
            <Plus className="h-4 w-4" /> New research
          </Link>
        </div>

        <div className="scroll-thin mt-4 flex-1 overflow-y-auto px-2">
          {chats.length > 0 && <div className="px-2 pb-1 text-[11px] uppercase tracking-wider text-muted">Recent</div>}
          <ul className="flex flex-col gap-0.5">
            {chats.map((c) => (
              <li key={c.id} className="group relative">
                <Link
                  href={`/c/${c.id}`}
                  onClick={followed}
                  className={clsx(
                    "flex items-center gap-2 rounded-lg py-2 pl-2 pr-8 text-sm",
                    c.id === activeId ? "bg-line/80 text-text" : "text-muted hover:bg-line/50 hover:text-text",
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{c.title}</span>
                </Link>
                <button
                  onClick={() => {
                    deleteChat(c.id);
                    if (c.id === activeId) {
                      onNew();
                      router.push("/");
                    }
                  }}
                  // Always visible on touch screens, which have no hover.
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-bad md:hidden md:group-hover:block"
                  aria-label="Delete chat"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-line p-3">
          <Link href="/settings" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-line/60 hover:text-text">
            <Settings className="h-4 w-4" /> System status
          </Link>
        </div>
      </aside>
    </>
  );
}
