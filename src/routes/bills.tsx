import { createFileRoute } from "@tanstack/react-router";
import { SimpleCrud } from "../components/SimpleCrud";
import { alphaStore, uid, useAlpha, type Bill } from "../lib/alpha-store";
import { ToolHeader } from "../components/ToolHeader";

export const Route = createFileRoute("/bills")({
  head: () => ({ meta: [{ title: "Alpha — Bills" }, { name: "description", content: "Track bills & balances." }] }),
  component: BillsRoute,
});

function BillsRoute() {
  const bills = useAlpha(s => s.bills);
  const total = bills.reduce((s, b) => s + (b.balance || 0), 0);
  return (
    <div className="starfield min-h-screen">
      <ToolHeader
        title="Ledger"
        right={
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Outstanding: <span className="text-primary font-semibold">${total.toFixed(2)}</span>
          </span>
        }
      />
      <SimpleCrud<Bill>
        title="Bills & Ledger"
        items={bills}
        fields={[
          { key: "name", label: "Name", type: "text" },
          { key: "amount", label: "Amount", type: "number", prefix: "$" },
          { key: "balance", label: "Balance", type: "number", prefix: "$" },
          { key: "dueDate", label: "Due Date", type: "date" },
          { key: "status", label: "Status", type: "select", options: ["due", "paid", "overdue"] },
        ]}
        makeNew={() => ({ id: uid(), name: "", amount: 0, balance: 0, dueDate: new Date().toISOString().slice(0, 10), status: "due" })}
        onSave={b => alphaStore.upsertBill(b)}
        onDelete={id => alphaStore.deleteBill(id)}
      />
    </div>
  );
}