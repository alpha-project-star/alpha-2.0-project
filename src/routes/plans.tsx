import { createFileRoute } from "@tanstack/react-router";
import { SimpleCrud } from "../components/SimpleCrud";
import { alphaStore, uid, useAlpha, type Task } from "../lib/alpha-store";
import { ToolHeader } from "../components/ToolHeader";

export const Route = createFileRoute("/plans")({
  head: () => ({ meta: [{ title: "Alpha — Tasks & Routes" }, { name: "description", content: "Tasks and routes." }] }),
  component: TasksRoute,
});

function TasksRoute() {
  const tasks = useAlpha(s => s.tasks);

  return (
    <div className="starfield min-h-screen">
      <ToolHeader title="Tasks" />
      <SimpleCrud<Task>
        title="Tasks"
        items={tasks}
        fields={[
          { key: "title", label: "Title", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "priority", label: "Priority", type: "text" },
          { key: "description", label: "Description", type: "textarea" },
        ]}
        makeNew={() => ({ 
          id: uid(), 
          title: "", 
          status: "draft", 
          priority: "medium", 
          createdAt: Date.now(),
          updatedAt: Date.now(),
          dependencies: [],
          cancellationState: "none"
        })}
        onSave={p => alphaStore.upsertTask(p)}
        onDelete={id => alphaStore.deleteTask(id)}
      />
    </div>
  );
}
