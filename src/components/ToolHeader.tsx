import { ReactNode, useState, useEffect } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Menu, X } from "lucide-react";
import { MiniOrb } from "./MiniOrb";
import { KittScanner, type KittState } from "./KittScanner";
import { TOOL_NAV_ITEMS } from "../lib/navigation";

export interface ToolHeaderProps {
  title: string;
  right?: ReactNode;
  scannerState?: KittState;
}

/**
 * Shared fixed/sticky header for Alpha tool pages (Notes, Bills, Plans, Memories, Reminders, Image, Settings).
 *
 * Implements:
 * 1. Fixed/sticky header layout matching Chat's reference implementation
 * 2. Centered MiniOrb with full voice interaction
 * 3. Integrated KittScanner lifecycle strip
 * 4. Clean right-side slot for page-specific actions/status
 * 5. Compact floating burger navigation button just beneath the far-left side of the fixed header
 * 6. Unified navigation dock matching Chat four-square destinations
 */
export function ToolHeader({ title, right, scannerState = "idle" }: ToolHeaderProps) {
  const [dockOpen, setDockOpen] = useState(false);
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  // Keyboard accessibility: Escape key closes the navigation dock
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && dockOpen) {
        setDockOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dockOpen]);

  return (
    <>
      <header className="sticky top-0 z-30 glass border-b border-primary/20 backdrop-blur-md shrink-0">
        <div className="grid grid-cols-[92px_1fr_92px] sm:grid-cols-[120px_1fr_120px] items-center gap-2 px-3 py-2.5 relative">
          {/* Left area: Back button & section title */}
          <div className="flex items-center gap-2 min-w-0 justify-start">
            <Link
              to="/"
              aria-label="Back to home"
              className="p-1.5 rounded-full glass neon-border shrink-0 active:scale-95 transition"
            >
              <ArrowLeft className="w-4 h-4 text-primary" />
            </Link>
            <span className="text-[11px] font-semibold tracking-wider uppercase truncate text-muted-foreground">
              {title}
            </span>
          </div>

          {/* Center area: Visually centered MiniOrb */}
          <div className="flex items-center justify-center">
            <MiniOrb size={50} />
          </div>

          {/* Right area: Page-specific controls or status */}
          <div className="flex items-center gap-1.5 min-w-0 justify-end">
            {right}
          </div>
        </div>

        {/* Integrated KITTScanner reflecting live lifecycle state */}
        <div className="px-3 pb-2">
          <KittScanner state={scannerState} bars={22} height={10} />
        </div>
      </header>

      {/* Floating burger navigation button: floats just beneath the far-left side of the fixed header */}
      <div className="fixed top-[84px] left-3 z-40">
        <button
          onClick={() => setDockOpen((v) => !v)}
          aria-label="Navigation menu"
          aria-expanded={dockOpen}
          aria-haspopup="dialog"
          className="p-2 rounded-xl glass neon-border hover:bg-primary/20 active:scale-95 transition shadow-lg flex items-center justify-center backdrop-blur-md"
        >
          {dockOpen ? (
            <X className="w-4 h-4 text-primary" />
          ) : (
            <Menu className="w-4 h-4 text-primary" />
          )}
        </button>

        {dockOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-background/20 backdrop-blur-xs"
              onClick={() => setDockOpen(false)}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Application navigation"
              className="absolute top-11 left-0 z-50 glass neon-border rounded-2xl p-2.5 grid grid-cols-3 gap-2 w-72 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100"
            >
              {TOOL_NAV_ITEMS.map(({ to, icon: Icon, label }) => {
                const isActive = currentPath === to;
                return (
                  <Link
                    key={to}
                    to={to as any}
                    onClick={() => setDockOpen(false)}
                    className={`flex flex-col items-center gap-1.5 px-2 py-2.5 rounded-xl transition active:scale-95 ${
                      isActive
                        ? "bg-primary/25 border border-primary/50 text-primary font-medium shadow-xs"
                        : "bg-background/40 hover:bg-background/70 text-foreground/80"
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${isActive ? "text-primary" : "text-primary/80"}`} />
                    <span className="text-[10px] tracking-wide">{label}</span>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
