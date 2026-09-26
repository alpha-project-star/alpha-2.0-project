import { describe, it, expect } from "vitest";
import { parseUploadedFile, formatUserBubbleContent, extractRtfText, cleanWordDocText } from "../src/lib/file-parser";
import { activity } from "../src/lib/activity";
import { stopAlphaGeneration } from "../src/lib/alpha.functions";
import type { ChatMessage } from "../src/lib/alpha-store";
import * as CFB from "cfb";

describe("File Attachment & Process Stop Audit", () => {
  it("correctly extracts text from text documents and sets activity", async () => {
    const file = new File(["Alpha system briefing content"], "briefing.txt", { type: "text/plain" });
    const parsed = await parseUploadedFile(file);

    expect(parsed.name).toBe("briefing.txt");
    expect(parsed.text).toBe("Alpha system briefing content");
    expect(parsed.size).toBe(file.size);
    expect(parsed.truncated).toBe(false);
  });

  it("verifies reading_file activity label is exactly 'Reading file..'", () => {
    activity.set("reading_file");
    const current = activity.get();
    expect(current.kind).toBe("reading_file");
    expect(activity.label(current)).toBe("Reading file..");
    activity.set("idle");
    expect(activity.get().kind).toBe("idle");
  });

  it("truncates content exceeding maximum character threshold safely", async () => {
    const largeContent = "A".repeat(100500);
    const file = new File([largeContent], "large_log.txt", { type: "text/plain" });
    const parsed = await parseUploadedFile(file);

    expect(parsed.truncated).toBe(true);
    expect(parsed.text.length).toBeLessThan(100500);
    expect(parsed.text).toContain("[... Truncated: File content exceeded 100000 characters]");
  });

  it("stopAlphaGeneration clears inFlight activity and resets state", () => {
    activity.set("thinking");
    expect(activity.get().kind).toBe("thinking");
    stopAlphaGeneration();
    expect(activity.get().kind).toBe("idle");
  });

  it("formatUserBubbleContent formats structured attachments into clean snapshot badges without dumping raw text", () => {
    const msg: ChatMessage = {
      id: "test-msg-1",
      role: "user",
      text: "Please analyze this report.",
      attachments: [
        {
          name: "quarterly_analysis.pdf",
          size: 45056,
          format: "pdf",
          text: "CONFIDENTIAL REVENUE REPORT RAW DATA LINES 1 TO 5000...",
        },
      ],
      ts: Date.now(),
    };

    const formatted = formatUserBubbleContent(msg);
    expect(formatted.attachments).toHaveLength(1);
    expect(formatted.attachments[0].name).toBe("quarterly_analysis.pdf");
    expect(formatted.attachments[0].sizeFormatted).toBe("44 KB");
    expect(formatted.attachments[0].format).toBe("pdf");
    expect(formatted.displayText).toBe("Please analyze this report.");
    // The raw data must not be in the display text
    expect(formatted.displayText).not.toContain("CONFIDENTIAL REVENUE REPORT");
  });

  it("formatUserBubbleContent safely intercepts legacy messages and converts raw code/text blocks into snapshot titles", () => {
    const legacyRawMessage: ChatMessage = {
      id: "legacy-msg-1",
      role: "user",
      text: `[ATTACHED FILE: "good,I want us-WPS Office.doc" (13 KB)]
\u0000\u0001\u0002Root Entry\u0000WordDocument\u00001Table\u0000Data
good,I want us to start cleaning the ui a bit.
[END OF FILE "good,I want us-WPS Office.doc"]

Please analyze and explain this attached document.`,
      ts: Date.now(),
    };

    const formatted = formatUserBubbleContent(legacyRawMessage);
    expect(formatted.attachments).toHaveLength(1);
    expect(formatted.attachments[0].name).toBe("good,I want us-WPS Office.doc");
    expect(formatted.attachments[0].sizeFormatted).toBe("13 KB");
    expect(formatted.attachments[0].format).toBe("doc");
    expect(formatted.displayText).toBe("Please analyze and explain this attached document.");
    // Verifies raw OLE and raw content is stripped from the user bubble display
    expect(formatted.displayText).not.toContain("Root Entry");
    expect(formatted.displayText).not.toContain("WordDocument");
  });

  it("extracts clean text from RTF formatted documents without control words", () => {
    const rtf = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\par Hello \\b Alpha User\\b0!\\par This is a test file.\\par}";
    const extracted = extractRtfText(rtf);
    expect(extracted).toContain("Hello Alpha User!");
    expect(extracted).toContain("This is a test file.");
    expect(extracted).not.toContain("\\rtf1");
    expect(extracted).not.toContain("\\fonttbl");
  });

  it("extracts text cleanly from an OLE2 Word .doc container without leaking container metadata", async () => {
    // Create an in-memory OLE2 compound file with a WordDocument stream
    const cfb = CFB.utils.cfb_new();
    const wordContent = Buffer.from(
      "\x00\x00WordDocument\x00\x001. Clean UI update\r2. Change drop cubed icon to burger icon\r3. Add paperclip icon\r\x00\x00"
    );
    CFB.utils.cfb_add(cfb, "/WordDocument", wordContent);
    CFB.utils.cfb_add(cfb, "/1Table", Buffer.from("Times New Roman\x00Calibri\x00"));
    CFB.utils.cfb_add(cfb, "/SummaryInformation", Buffer.from("WPS Office\x00SM-M536S\x00"));

    const cfbBytes = CFB.write(cfb, { type: "buffer" });
    const file = new File([cfbBytes], "good,I want us-WPS Office.doc", { type: "application/msword" });

    const parsed = await parseUploadedFile(file);
    expect(parsed.name).toBe("good,I want us-WPS Office.doc");
    expect(parsed.text).toContain("1. Clean UI update");
    expect(parsed.text).toContain("2. Change drop cubed icon to burger icon");
    expect(parsed.text).toContain("3. Add paperclip icon");
    // Ensure container headers are excluded
    expect(parsed.text).not.toContain("Root Entry");
    expect(parsed.text).not.toContain("Times New Roman");
  });
});
