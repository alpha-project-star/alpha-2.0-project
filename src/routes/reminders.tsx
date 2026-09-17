import { createFileRoute } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { SimpleCrud } from "../components/SimpleCrud";
import { uid } from "../lib/alpha-store";
import { requestAlarmPermission } from "../lib/alarm-engine";
import { useState, useEffect, useMemo } from "react";
import { ToolHeader } from "../components/ToolHeader";
import { useAuth } from "../lib/auth";
import { FirestoreReminderRepository, type ReminderState, type NotificationState } from "../lib/reminder-repo";
import { normalizeWhen } from "../lib/when";

export const Route = createFileRoute("/reminders")({
  head: () => ({ meta: [{ title: "Alpha — Reminders" }, { name: "description", content: "Alarms and reminders." }] }),
  component: RemindersRoute,
});

type UIReminder = {
  id: string;
  title: string;
  when: string;
  notes: string;
  state: ReminderState;
};

function RemindersRoute() {
  const auth = useAuth();
  const userId = auth.status === 'authenticated' ? auth.user.uid : null;
  const [reminders, setReminders] = useState<UIReminder[]>([]);
  const [permMsg, setPermMsg] = useState("");
  const repo = useMemo(() => new FirestoreReminderRepository(), []);

  useEffect(() => {
    const loadReminders = () => {
      if (!userId) {
        setReminders([]);
        return;
      }
      repo.listReminders(userId).then(list => {
        setReminders(list.map(r => ({
          id: r.id,
          title: r.title,
          when: new Date(r.dueAt).toLocaleString(),
          notes: r.notes || "",
          state: r.reminderState
        })));
      });
    };

    loadReminders();
    const handleRefresh = () => loadReminders();
    window.addEventListener("alpha:reminders-changed", handleRefresh);
    return () => window.removeEventListener("alpha:reminders-changed", handleRefresh);
  }, [userId, repo]);

  const loadRemindersForSave = () => {
    if (!userId) {
      setReminders([]);
      return;
    }
    repo.listReminders(userId).then(list => {
      setReminders(list.map(r => ({
        id: r.id,
        title: r.title,
        when: new Date(r.dueAt).toLocaleString(),
        notes: r.notes || "",
        state: r.reminderState
      })));
    });
  };

  async function enableAlarms() {
    const ok = await requestAlarmPermission();
    setPermMsg(ok ? "✅ Alarms enabled." : "⚠️ Notification permission denied — alarms will still speak, but no system pop-ups.");
  }

  const handleSave = async (r: UIReminder) => {
    if (!userId) return;
    const w = normalizeWhen(r.when);
    const ms = w.parsed ? new Date(w.iso).getTime() : Date.parse(r.when);
    const dueAt = Number.isNaN(ms) || !ms ? Date.now() : ms;

    const exists = await repo.getReminder(userId, r.id);
    if (exists) {
      await repo.updateReminder(userId, r.id, {
        title: r.title,
        dueAt,
        notes: r.notes,
        reminderState: r.state
      });
    } else {
      await repo.createReminder(userId, {
        id: r.id,
        userId,
        title: r.title,
        dueAt,
        notes: r.notes,
        reminderState: r.state,
        notificationState: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    loadRemindersForSave();
    window.dispatchEvent(new CustomEvent("alpha:reminders-changed"));
  };

  const handleDelete = async (id: string) => {
    if (!userId) return;
    await repo.deleteReminder(userId, id);
    loadRemindersForSave();
    window.dispatchEvent(new CustomEvent("alpha:reminders-changed"));
  };

  return (
    <div className="starfield min-h-screen">
      <ToolHeader
        title="Reminders"
        right={
          <button
            onClick={enableAlarms}
            className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full glass neon-border whitespace-nowrap active:scale-95 transition"
          >
            <Bell className="w-3 h-3 text-primary" /> Alarms
          </button>
        }
      />
      {permMsg && <div className="px-4 pt-3 text-xs text-muted-foreground">{permMsg}</div>}
      <div className="px-4 pt-3 text-[11px] text-muted-foreground">
        Tip: for "When" use an ISO date/time (e.g. <code>2026-07-15T09:00</code>) or say "in 5 minutes" / "tomorrow 8am" to Alpha.
      </div>
      
      {auth.status === 'loading' ? (
        <div className="px-4 py-12 text-center text-sm text-muted-foreground animate-pulse">
          Connecting to Alpha reminders...
        </div>
      ) : !userId ? (
        <div className="px-4 py-12 text-center text-sm text-muted-foreground">
          Sign in via Settings to manage reminders.
        </div>
      ) : (
        <SimpleCrud<UIReminder>
          title="Reminders & Alarms"
          items={reminders}
          fields={[
            { key: "title", label: "Title", type: "text" },
            { key: "when", label: "When (Date/Time or Text)", type: "text" },
            { key: "notes", label: "Notes", type: "textarea" },
            { key: "state", label: "State", type: "select", options: ["active", "completed", "cancelled"] },
          ]}
          makeNew={() => ({ id: uid(), title: "", when: "", notes: "", state: "active" })}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}