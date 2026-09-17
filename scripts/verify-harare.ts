import { BoundedResearchService } from "../src/lib/research";

async function run() {
    const service = new BoundedResearchService();
    console.log("Searching for Harare Polytechnic application status...");
    const result = await service.research("Harare Polytechnic application status");
    
    console.log("Evidence Found:", result.evidence.length);
    for (const ev of result.evidence) {
        console.log("---");
        console.log("URL:", ev.url);
        console.log("Title:", ev.title);
        console.log("Excerpt Length:", ev.excerpt.length);
        console.log("Excerpt Preview:", ev.excerpt.slice(0, 200) + "...");
    }
}

run().catch(console.error);
