import { createFileRoute } from "@tanstack/react-router";
import { SimpleCrud } from "../components/SimpleCrud";
import { alphaStore, uid, useAlpha, type Memory } from "../lib/alpha-store";
import { ToolHeader } from "../components/ToolHeader";

export const Route = createFileRoute("/memories")({
  head: () => ({ meta: [{ title: "Alpha — Memories" }, { name: "description", content: "Things Alpha remembers about you." }] }),
  component: MemoriesRoute,
});

function MemoriesRoute() {
  const memories = useAlpha(s => s.memories);
  return (
    <div className="starfield min-h-screen">
      <ToolHeader title="Memories" />
      <SimpleCrud<Memory>
        title="Long-term memory"
        items={memories}
        fields={[
          { key: "topic", label: "Topic", type: "text" },
          { key: "detail", label: "Detail", type: "textarea" },
        ]}
        makeNew={() => ({ id: uid(), topic: "", detail: "", updatedAt: Date.now() })}
        onSave={m => alphaStore.upsertMemory({ ...m, updatedAt: Date.now() })}
        onDelete={id => alphaStore.deleteMemory(id)}
      />
    </div>
  );
}