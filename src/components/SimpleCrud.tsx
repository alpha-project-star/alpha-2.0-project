import { useState } from "react";
import { RichText } from "./MessageContent";
import { Volume2 } from "lucide-react";
import { prepareUtterance, speakWith } from "../lib/voice";

export type FieldType = "text" | "textarea" | "number" | "date" | "select";
export interface FieldDef<T> {
  key: keyof T & string;
  label: string;
  type: FieldType;
  options?: string[];
  prefix?: string;
  suffix?: string;
}

export function SimpleCrud<T extends { id: string }>({
  title,
  items,
  fields,
  makeNew,
  onSave,
  onDelete,
}: {
  title: string;
  items: T[];
  fields: FieldDef<T>[];
  makeNew: () => T;
  onSave: (item: T) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<T | null>(null);

  /** Everything a card shows, read aloud with the same sanitiser chat uses. */
  function speakItem(item: T) {
    const parts = fields
      .map((f) => {
        const v = (item as any)[f.key];
        if (v === undefined || v === null || v === "") return "";
        return `${f.label}: ${v}`;
      })
      .filter(Boolean);
    prepareUtterance();
    speakWith(parts.join(". "));
  }

  return (
    <div className="px-4 py-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold neon-text">{title}</h1>
        <button
          onClick={() => setEditing(makeNew())}
          className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm font-semibold neon-border"
        >
          + New
        </button>
      </div>

      {editing && (
        <div className="glass rounded-xl p-4 mb-4">
          {fields.map((f) => (
            <label key={f.key} className="block mb-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                {f.label}
              </div>
              {f.type === "textarea" ? (
                <>
                  {/* Plain-text editing preserves the exact Markdown that was saved. */}
                  <textarea
                    value={(editing as any)[f.key] ?? ""}
                    onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })}
                    className="w-full bg-input rounded-md px-3 py-2 border border-border outline-none focus:border-primary min-h-[140px] text-base leading-relaxed font-mono"
                  />
                  <div className="text-[11px] text-muted-foreground mt-1 leading-[1.4]">
                    Formatting (headings, lists, tables, code, maths) is preserved and rendered
                    below once saved.
                  </div>
                </>
              ) : f.type === "select" ? (
                <select
                  value={(editing as any)[f.key] ?? ""}
                  onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })}
                  className="w-full bg-input rounded-md px-3 py-2 border border-border"
                >
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                  value={(editing as any)[f.key] ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
                    })
                  }
                  className="w-full bg-input rounded-md px-3 py-2 border border-border outline-none focus:border-primary text-base"
                />
              )}
            </label>
          ))}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setEditing(null)}
              className="px-3 py-2 text-sm rounded-md border border-border"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onSave(editing);
                setEditing(null);
              }}
              className="px-3 py-2 text-sm rounded-md bg-primary text-primary-foreground font-semibold"
            >
              Save
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {items.length === 0 && (
          <div className="text-muted-foreground text-sm text-center py-12">Nothing here yet.</div>
        )}
        {items.map((item) => (
          <div key={item.id} className="glass rounded-xl p-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {fields.map((f) => {
                const raw = (item as any)[f.key];
                const isLong = f.type === "textarea";
                return (
                  <div key={f.key} className={isLong ? "col-span-2 min-w-0" : "min-w-0"}>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground leading-[1.4]">
                      {f.label}
                    </div>
                    {isLong ? (
                      raw ? (
                        <div className="mt-1.5">
                          <RichText text={String(raw)} />
                        </div>
                      ) : (
                        <div className="text-sm text-muted-foreground mt-1">—</div>
                      )
                    ) : (
                      <div className="text-[15px] leading-[1.5] text-foreground/90 break-words mt-0.5">
                        {f.prefix}
                        {raw === undefined || raw === null || raw === "" ? "—" : String(raw)}
                        {f.suffix}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => speakItem(item)}
                aria-label="Read aloud"
                className="text-xs px-2 py-1 rounded border border-border inline-flex items-center gap-1"
              >
                <Volume2 className="w-3.5 h-3.5 text-primary" /> Read
              </button>
              <button
                onClick={() => setEditing(item)}
                className="text-xs px-2 py-1 rounded border border-border"
              >
                Edit
              </button>
              <button
                onClick={() => onDelete(item.id)}
                className="text-xs px-2 py-1 rounded border border-destructive/40 text-destructive"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
