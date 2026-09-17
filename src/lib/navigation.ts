import {
  Sparkles,
  MessageSquare,
  NotebookPen,
  Wallet,
  ImageIcon,
  Bell,
  Map,
  Brain,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavDestination {
  to: string;
  icon: LucideIcon;
  label: string;
}

/**
 * Coherent application navigation destinations shared across Chat four-square dock,
 * tool-page floating burger dock, and home dock.
 */
export const TOOL_NAV_ITEMS: readonly NavDestination[] = [
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

/**
 * Chat-specific navigation list (excludes current chat view for clean 8-grid).
 */
export const CHAT_NAV_ITEMS: readonly NavDestination[] = [
  { to: "/", icon: Sparkles, label: "Orb" },
  { to: "/notes", icon: NotebookPen, label: "Notes" },
  { to: "/bills", icon: Wallet, label: "Bills" },
  { to: "/image", icon: ImageIcon, label: "Image" },
  { to: "/reminders", icon: Bell, label: "Reminders" },
  { to: "/plans", icon: Map, label: "Plans" },
  { to: "/memories", icon: Brain, label: "Memories" },
  { to: "/settings", icon: SettingsIcon, label: "Settings" },
] as const;
