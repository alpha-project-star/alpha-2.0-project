import { createFileRoute } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { SimpleCrud } from "../components/SimpleCrud";
import { uid } from "../lib/alpha-store";
import { requestAlarmPermission } from "../lib/alarm-engine";
import { useState, useEffect, useMemo } from "react";
import { ToolHeader } from "../components/ToolHeader";
import { useAuth } from "../lib/auth";
import { LocalReminderRepository, reminderRepository, type ReminderState, type NotificationState } from "../lib/reminder-repo";
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
  const userId = auth.status === 'authenticated' ? auth.user.uid : 'local-user';
  const [reminders, setReminders] = useState<UIReminder[]>([]);
  const [permMsg, setPermMsg] = useState("");
  const [timeError, setTimeError] = useState("");
  const repo = reminderRepository;

  useEffect(() => {
    const loadReminders = () => {
      repo
        .listReminders(userId)
        .then((list) => {
          setReminders(
            list.map((r) => ({
              id: r.id,
              title: r.title,
              when: new Date(r.dueAt).toLocaleString(),
              notes: r.notes || "",
              state: r.reminderState,
            }))
          );
        })
        .catch((err) => {
          console.error("Failed to load reminders:", err);
        });
    };

    loadReminders();
    const handleRefresh = () => loadReminders();
    window.addEventListener("alpha:reminders-changed", handleRefresh);
    return () => window.removeEventListener("alpha:reminders-changed", handleRefresh);
  }, [userId, repo]);

  const loadRemindersForSave = () => {
    repo
      .listReminders(userId)
      .then((list) => {
        setReminders(
          list.map((r) => ({
            id: r.id,
            title: r.title,
            when: new Date(r.dueAt).toLocaleString(),
            notes: r.notes || "",
            state: r.reminderState,
          }))
        );
      })
      .catch((err) => {
        console.error("Failed to load reminders for save:", err);
      });
  };

  async function enableAlarms() {
    const ok = await requestAlarmPermission();
    setPermMsg(ok ? "✅ Alarms enabled." : "⚠️ Notification permission denied — alarms will still speak, but no system pop-ups.");
  }

  const handleSave = async (r: UIReminder) => {
    setTimeError("");
    const w = normalizeWhen(r.when);
    const ms = w.parsed ? new Date(w.iso).getTime() : Date.parse(r.when);
    if (Number.isNaN(ms) || !ms) {
      setTimeError("Please specify a valid time (e.g. 'in 10 minutes', 'tomorrow 9am', or '2026-07-15T09:00'). Invented times are not allowed.");
      return;
    }
    const dueAt = ms;

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
      {timeError && (
        <div className="mx-4 mt-3 p-2.5 rounded bg-destructive/10 text-destructive text-xs border border-destructive/20 font-medium">
          {timeError}
        </div>
      )}
      <div className="px-4 pt-3 text-[11px] text-muted-foreground">
        Tip: for "When" use an ISO date/time (e.g. <code>2026-07-15T09:00</code>) or say "in 5 minutes" / "tomorrow 8am" to Alpha.
      </div>
      
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
    </div>
  );
}