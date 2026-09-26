import React, { useState, useRef, useEffect } from "react";
import { History, Plus, Edit2, Check, Trash2, X, MessageSquare } from "lucide-react";
import { alphaStore, useAlpha, type ChatSession } from "../lib/alpha-store";

interface SessionDrawerProps {
  className?: string;
}

export function SessionDrawer({ className = "" }: SessionDrawerProps) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = useAlpha((s) => s.sessions || []);
  const activeSessionId = useAlpha((s) => s.activeSessionId || "default");
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  function startEditing(session: ChatSession, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  }

  async function saveTitle(sessionId: string) {
    if (editTitle.trim()) {
      await alphaStore.renameSession(sessionId, editTitle.trim());
    }
    setEditingId(null);
  }

  async function handleKeyDown(e: React.KeyboardEvent, sessionId: string) {
    if (e.key === "Enter") {
      await saveTitle(sessionId);
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  }

  async function handleCreateSession() {
    await alphaStore.createSession("New Conversation");
    setOpen(false);
  }

  async function handleSelectSession(sessionId: string) {
    if (sessionId !== activeSessionId) {
      await alphaStore.switchSession(sessionId);
    }
    setOpen(false);
  }

  async function handleDeleteSession(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    await alphaStore.deleteSession(sessionId);
  }

  return (
    <div className={`relative ${className}`}>
      {/* Trigger Button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg glass neon-border text-xs text-foreground/80 hover:text-foreground hover:border-primary/50 transition-all active:scale-95 group"
        title="Chat Sessions & History"
      >
        <History className="w-3.5 h-3.5 text-primary group-hover:rotate-[-20deg] transition-transform" />
        <span className="max-w-[130px] truncate font-medium">
          {activeSession?.title || "Conversation"}
        </span>
      </button>

      {/* Slide-out / Dropdown Modal */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-start justify-center sm:justify-end p-4 sm:p-6 bg-background/60 backdrop-blur-sm animate-fade-in"
        >
          <div
            className="w-full max-w-sm glass neon-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] bg-background/95 border border-primary/30"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-3.5 border-b border-primary/20 bg-primary/5">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-primary" />
                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                  Neural Sessions
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCreateSession}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-all active:scale-95 shadow-sm"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New</span>
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Session List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {sessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const isEditing = editingId === session.id;

                return (
                  <div
                    key={session.id}
                    onClick={() => !isEditing && handleSelectSession(session.id)}
                    className={`group flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer ${
                      isActive
                        ? "bg-primary/15 border-primary/50 text-foreground shadow-sm"
                        : "bg-white/[0.02] border-white/5 hover:border-primary/30 hover:bg-white/[0.05] text-muted-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                      <MessageSquare
                        className={`w-4 h-4 shrink-0 ${
                          isActive ? "text-primary" : "text-muted-foreground/60"
                        }`}
                      />

                      {isEditing ? (
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <input
                            ref={inputRef}
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, session.id)}
                            onBlur={() => saveTitle(session.id)}
                            className="flex-1 px-2 py-0.5 rounded bg-background border border-primary text-xs text-foreground focus:outline-none"
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void saveTitle(session.id);
                            }}
                            className="p-1 text-primary hover:text-primary/80"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-xs font-medium truncate">
                            {session.title}
                          </span>
                          <span className="text-[10px] text-muted-foreground/60">
                            {new Date(session.updatedAt || session.createdAt).toLocaleDateString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Action buttons */}
                    {!isEditing && (
                      <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => startEditing(session, e)}
                          title="Rename Session"
                          className="p-1 rounded hover:bg-primary/20 text-muted-foreground hover:text-primary transition-colors"
                        >
                          <Edit2 className="w-3 h-3" />
                        </button>
                        {sessions.length > 1 && (
                          <button
                            onClick={(e) => handleDeleteSession(session.id, e)}
                            title="Delete Session"
                            className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
