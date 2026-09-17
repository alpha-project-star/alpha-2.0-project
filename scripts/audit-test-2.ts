import { decideSearch } from "../src/lib/web-search";

async function runTest() {
  const query = "Explain Newton’s three laws of motion in simple terms.";
  const decision = decideSearch(query);
  console.log(`Web tool selected: ${decision.search}`);
  console.log(`Exact dispatched query: null`);
  console.log(`WebToolReceipt: not_attempted`);
  console.log(`Status: not_attempted`);
}
runTest();
