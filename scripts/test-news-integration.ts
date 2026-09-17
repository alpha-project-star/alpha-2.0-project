
import { sendChat } from "../src/lib/alpha.functions";

async function testNewsIntegration() {
  const history = [
    { 
        role: "user", 
        text: "What are today's Zimbabwe headlines? Give me 3–5 verified headlines with brief summaries and source links. Don't show your search process.",
        ts: Date.now() 
    }
  ];

  console.log("--- Starting End-to-End News Integration Test ---");
  
  try {
    // In a real environment, sendChat handles the search internally
    const response = await sendChat(history, { task: "auto" });
    
    console.log("\n--- Alpha Final Response ---");
    console.log(response);
    console.log("\n--- End of Response ---");
  } catch (error) {
    console.error("Test failed:", error);
  }
}

testNewsIntegration();
