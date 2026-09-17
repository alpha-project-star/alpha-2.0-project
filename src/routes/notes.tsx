import { createFileRoute } from "@tanstack/react-router";
import { SimpleCrud } from "../components/SimpleCrud";
import { alphaStore, uid, useAlpha, type Note } from "../lib/alpha-store";
import { ToolHeader } from "../components/ToolHeader";

export const Route = createFileRoute("/notes")({
  head: () => ({ meta: [{ title: "Alpha — Notes" }, { name: "description", content: "Quick plaintext notes." }] }),
  component: NotesRoute,
});

function NotesRoute() {
  const notes = useAlpha(s => s.notes);
  return (
    <div className="starfield min-h-screen">
      <ToolHeader title="Notes" />
      <SimpleCrud<Note>
        title="Your Notes"
        items={notes}
        fields={[
          { key: "title", label: "Title", type: "text" },
          { key: "body", label: "Body", type: "textarea" },
        ]}
        makeNew={() => ({ id: uid(), title: "", body: "", updatedAt: Date.now() })}
        onSave={n => alphaStore.upsertNote({ ...n, updatedAt: Date.now() })}
        onDelete={id => alphaStore.deleteNote(id)}
      />
    </div>
  );
}