import { Link } from "@tanstack/react-router";
import {
  MessageSquare,
  NotebookPen,
  Wallet,
  Image as ImageIcon,
  Bell,
  Map,
  Brain,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";

const ITEMS = [
  { to: "/", icon: Sparkles, label: "Orb" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/notes", icon: NotebookPen, label: "Notes" },
  { to: "/bills", icon: Wallet, label: "Bills" },
  { to: "/image", icon: ImageIcon, label: "Image" },
  { to: "/reminders", icon: Bell, label: "Reminders" },
  { to: "/plans", icon: Map, label: "Plans" },
  { to: "/memories", icon: Brain, label: "Memories" },
  { to: "/settings", icon: SettingsIcon, label: "Settings" },
] as const;

/** Vertical HUD tool rail on the left edge (desktop only). */
export function ToolRail() {
  return (
    <nav
      aria-label="Tools"
      className="hidden lg:flex fixed left-4 top-1/2 -translate-y-1/2 z-30 flex-col gap-2 hud-frame hud-frame-corners p-2"
    >
      {ITEMS.map(({ to, icon: Icon, label }) => (
        <Link
          key={to}
          to={to as any}
          aria-label={label}
          title={label}
          className="group relative w-10 h-10 rounded-lg flex items-center justify-center hover:bg-primary/15 transition"
        >
          <Icon className="w-5 h-5" style={{ color: "var(--hud-cyan)" }} />
          <span className="absolute left-full ml-2 px-2 py-1 rounded-md hud-bubble text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition pointer-events-none">
            {label}
          </span>
        </Link>
      ))}
    </nav>
  );
}
