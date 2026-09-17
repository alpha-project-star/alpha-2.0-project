import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare, Sparkles } from "lucide-react";
import { MiniOrb } from "./MiniOrb";
import { PWAInstallButton } from "./PWAInstallButton";

/**
 * Obsolete floating dock superseded by UI-2 ToolHeader.
 * Returns null to eliminate duplicate controls across tool pages.
 */
export function GlobalDock() {
  return null;
}

/** Reusable back arrow shown in every secondary page header. */
export function BackArrow({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} aria-label="Back" className="p-1.5 rounded-full glass neon-border">
      <ArrowLeft className="w-4 h-4 text-primary" />
    </Link>
  );
}
