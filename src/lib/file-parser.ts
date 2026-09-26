/**
 * File Parser & Document Text Extractor
 * Supports PDF, Word (.docx, .doc), RTF, plain text, markdown, CSV, JSON, and code files.
 */

import { activity } from "./activity";
import type { ChatMessage } from "./alpha-store";

export interface ParsedDocument {
  name: string;
  size: number;
  type: string;
  text: string;
  truncated: boolean;
}

const MAX_DOC_CHARS = 100000;

export async function parseUploadedFile(file: File): Promise<ParsedDocument> {
  activity.set("reading_file");
  const startTime = Date.now();
  const fileName = file.name || "document";
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
    : "";

  try {
    let extractedText = "";

    if (ext === ".pdf") {
      extractedText = await extractPdfText(file);
    } else if (ext === ".docx") {
      extractedText = await extractDocxText(file);
    } else if (ext === ".doc") {
      extractedText = await extractDocText(file);
    } else if (ext === ".rtf") {
      extractedText = await extractRtfFile(file);
    } else {
      // Plain text, Markdown, CSV, JSON, code, etc.
      const raw = await file.text();
      // Safety check: if raw text starts with CFBF magic bytes or RTF, route accordingly
      if (raw.startsWith("{\\rtf")) {
        extractedText = extractRtfText(raw);
      } else if (raw.charCodeAt(0) === 0xd0 && raw.charCodeAt(1) === 0xcf) {
        // Renamed .doc file
        extractedText = await extractDocText(file);
      } else {
        extractedText = sanitizeExtractedText(raw);
      }
    }

    const elapsed = Date.now() - startTime;
    if (elapsed < 400) {
      await new Promise((r) => setTimeout(r, 400 - elapsed));
    }

    const clean = sanitizeExtractedText(extractedText);
    const truncated = clean.length > MAX_DOC_CHARS;
    const finalContent = truncated
      ? clean.slice(0, MAX_DOC_CHARS) + `\n\n[... Truncated: File content exceeded ${MAX_DOC_CHARS} characters]`
      : clean;

    return {
      name: fileName,
      size: file.size,
      type: ext.replace(/^\./, "") || file.type || "file",
      text: finalContent.trim(),
      truncated,
    };
  } finally {
    activity.set("idle");
  }
}

/**
 * Strips raw non-printable control characters while preserving standard formatting.
 */
export function cleanWordDocText(text: string): string {
  if (!text) return "";
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x07/g, "\t") // Word table cell delimiter -> tab
    // eslint-disable-next-line no-control-regex
    .replace(/\x0B/g, "\n") // Word soft return -> newline
    .replace(/\r\n?/g, "\n") // Normalise newlines
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, "") // Strip NUL and non-printable control bytes
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeExtractedText(text: string): string {
  if (!text) return "";
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * Cleanly extracts text from Word 97-2004 legacy binary (.doc) files,
 * including WPS Office exports and OLE2 Compound File Binary containers.
 */
async function extractDocText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);

  // 1. RTF header check ({\rtf1)
  if (
    uint8.length >= 5 &&
    uint8[0] === 0x7b &&
    uint8[1] === 0x5c &&
    uint8[2] === 0x72 &&
    uint8[3] === 0x74 &&
    uint8[4] === 0x66
  ) {
    const decoder = new TextDecoder("latin1");
    return extractRtfText(decoder.decode(uint8));
  }

  // 2. Word 2003 XML or HTML disguised as .doc
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(uint8.subarray(0, 1000));
  if (preview.startsWith("<?xml") || preview.includes("<html") || preview.includes("<!DOCTYPE")) {
    const full = new TextDecoder("utf-8", { fatal: false }).decode(uint8);
    return cleanWordDocText(full.replace(/<[^>]+>/g, " "));
  }

  // 3. OLE2 Compound File Binary extraction via CFB
  try {
    const CFB = await import("cfb");
    const cfb = CFB.read(uint8, { type: "array" });
    const wordEntry = CFB.find(cfb, "/WordDocument") || CFB.find(cfb, "WordDocument");
    const tableEntry =
      CFB.find(cfb, "/1Table") ||
      CFB.find(cfb, "1Table") ||
      CFB.find(cfb, "/0Table") ||
      CFB.find(cfb, "0Table");

    if (wordEntry && wordEntry.content) {
      const wordDocBuf = new Uint8Array(wordEntry.content as any);
      const tableBuf =
        tableEntry && tableEntry.content ? new Uint8Array(tableEntry.content as any) : null;
      const text = extractTextFromWordStreams(wordDocBuf, tableBuf);
      if (text && text.trim().length > 0) {
        return text;
      }
    }
  } catch (err: any) {
    console.warn("[FileParser] CFB WordDocument extraction error, falling back to stream scanner:", err);
  }

  // 4. Fallback: Scan printable runs from raw document buffer
  return extractPrintableDocRuns(uint8);
}

/**
 * Extracts text from the WordDocument stream and Table stream using Piece Table (Clx) or FIB character pointers.
 */
function extractTextFromWordStreams(wordDocBuf: Uint8Array, tableBuf: Uint8Array | null): string {
  if (!wordDocBuf || wordDocBuf.length < 32) return "";
  const view = new DataView(wordDocBuf.buffer, wordDocBuf.byteOffset, wordDocBuf.byteLength);
  const wIdent = view.getUint16(0, true);

  // Standard Word 97-2004 FIB header
  if ((wIdent === 0xa5ec || wIdent === 0xa5dc) && tableBuf && wordDocBuf.length >= 0x01aa) {
    const fcClx = view.getUint32(0x01a2, true);
    const lcbClx = view.getUint32(0x01a6, true);

    if (lcbClx > 0 && fcClx + lcbClx <= tableBuf.length) {
      try {
        let pos = fcClx;
        const end = fcClx + lcbClx;
        while (pos < end) {
          const clxt = tableBuf[pos];
          pos++;
          if (clxt === 1) {
            // Prc block
            const cb = tableBuf[pos] | (tableBuf[pos + 1] << 8);
            pos += 2 + cb;
          } else if (clxt === 2) {
            // Plcfpcd (Piece table)
            const lcb =
              (tableBuf[pos] |
                (tableBuf[pos + 1] << 8) |
                (tableBuf[pos + 2] << 16) |
                (tableBuf[pos + 3] << 24)) >>>
              0;
            pos += 4;
            const n = Math.floor((lcb - 4) / 12);
            if (n > 0 && pos + (n + 1) * 4 + n * 8 <= tableBuf.length) {
              const cpArray: number[] = [];
              for (let i = 0; i <= n; i++) {
                const cp =
                  (tableBuf[pos] |
                    (tableBuf[pos + 1] << 8) |
                    (tableBuf[pos + 2] << 16) |
                    (tableBuf[pos + 3] << 24)) >>>
                  0;
                cpArray.push(cp);
                pos += 4;
              }

              let extracted = "";
              for (let i = 0; i < n; i++) {
                const pcdOffset = pos + i * 8;
                const fc =
                  (tableBuf[pcdOffset + 2] |
                    (tableBuf[pcdOffset + 3] << 8) |
                    (tableBuf[pcdOffset + 4] << 16) |
                    (tableBuf[pcdOffset + 5] << 24)) >>>
                  0;
                const isCompressed = (fc & 0x40000000) !== 0;
                const actualFc = isCompressed ? (fc & ~0x40000000) / 2 : fc;
                const cpCount = cpArray[i + 1] - cpArray[i];

                if (isCompressed) {
                  // 8-bit text (Windows-1252 / ANSI)
                  const startByte = actualFc;
                  const endByte = Math.min(startByte + cpCount, wordDocBuf.length);
                  if (startByte < wordDocBuf.length) {
                    const slice = wordDocBuf.subarray(startByte, endByte);
                    extracted += new TextDecoder("windows-1252").decode(slice);
                  }
                } else {
                  // 16-bit text (UTF-16LE)
                  const startByte = actualFc;
                  const endByte = Math.min(startByte + cpCount * 2, wordDocBuf.length);
                  if (startByte < wordDocBuf.length) {
                    const slice = wordDocBuf.subarray(startByte, endByte);
                    extracted += new TextDecoder("utf-16le").decode(slice);
                  }
                }
              }

              const cleaned = cleanWordDocText(extracted);
              if (cleaned.length > 0) {
                return cleaned;
              }
            }
            break;
          } else {
            break;
          }
        }
      } catch (err) {
        console.warn("[FileParser] Piece table parse failed, using fallback:", err);
      }
    }
  }

  // Fallback: Scan printable runs from WordDocument stream
  return extractPrintableDocRuns(wordDocBuf);
}

/**
 * Scans contiguous printable text runs from binary buffers, filtering out OLE headers and metadata keywords.
 */
function extractPrintableDocRuns(buf: Uint8Array): string {
  // Use a more restrictive decoder and regex to avoid binary junk
  const latinText = new TextDecoder("windows-1252", { fatal: false }).decode(buf);
  const utf16Text = new TextDecoder("utf-16le", { fatal: false }).decode(buf);

  // OLE2 and Word internal stream names/keywords to exclude
  const OLE_INTERNAL =
    /^(?:Root Entry|WordDocument|1Table|0Table|Data|SummaryInformation|DocumentSummaryInformation|CompObj|ObjectPool|Macros|Table|Paragraph|Font|Style|Section|List|Field|Bookmark|Annotation|Table Normal|No List|Default Paragraph Font|Normal|WPS Office|Times New Roman|Arial|Calibri|SimSun|Symbol|Cambria Math|Tahoma|Verdana|Georgia|Courier New|Segoe UI|Microsoft Sans Serif)$/i;

  // We look for longer runs of printable ASCII to reduce noise in binary blobs.
  // We also filter out runs that are likely just OLE metadata or font names.
  const latinRuns = (latinText.match(/[\x20-\x7E\r\n\t]{12,}/g) || [])
    .map((r) => cleanWordDocText(r))
    .filter((r) => r.length > 10 && !OLE_INTERNAL.test(r) && !/^[ \t\r\n]+$/.test(r));

  const utf16Runs = (utf16Text.match(/[\x20-\x7E\r\n\t]{12,}/g) || [])
    .map((r) => cleanWordDocText(r))
    .filter((r) => r.length > 10 && !OLE_INTERNAL.test(r) && !/^[ \t\r\n]+$/.test(r));

  const latinScore = latinRuns.join(" ").length;
  const utf16Score = utf16Runs.join(" ").length;

  // If one encoding yields significantly more text, prefer it.
  // Otherwise, join and deduplicate.
  if (utf16Score > latinScore * 2) {
    return utf16Runs.join("\n\n").trim();
  }
  if (latinScore > utf16Score * 2) {
    return latinRuns.join("\n\n").trim();
  }

  // Fallback: merge them but prioritize longer runs
  const allRuns = Array.from(new Set([...latinRuns, ...utf16Runs]));
  return allRuns.join("\n\n").trim();
}

/**
 * Simple, robust RTF text extractor without external dependencies.
 */
async function extractRtfFile(file: File): Promise<string> {
  const text = await file.text();
  return extractRtfText(text);
}

export function extractRtfText(rtf: string): string {
  if (!rtf) return "";
  let text = rtf;
  // Strip font tables, color tables, stylesheets, metadata blocks
  text = text.replace(/{\\fonttbl[\s\S]*?}/g, "");
  text = text.replace(/{\\colortbl[\s\S]*?}/g, "");
  text = text.replace(/{\\stylesheet[\s\S]*?}/g, "");
  text = text.replace(/{\\info[\s\S]*?}/g, "");
  text = text.replace(/{\\\*[\s\S]*?}/g, "");
  // Unescape hex \'hh
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Unescape unicode \uN?
  text = text.replace(/\\u(-?\d+)\??/g, (_, code) => {
    const n = parseInt(code, 10);
    return String.fromCharCode(n < 0 ? n + 65536 : n);
  });
  // Paragraphs, lines, tabs
  text = text.replace(/\\par[d]?\b/g, "\n");
  text = text.replace(/\\tab\b/g, "\t");
  text = text.replace(/\\line\b/g, "\n");
  // Remove remaining control tags
  text = text.replace(/\\[a-zA-Z]+(-?\d+)? ?/g, "");
  // Remove group braces
  text = text.replace(/[{}]/g, "");
  return cleanWordDocText(text);
}

async function extractDocxText(file: File): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    if (result.value && result.value.trim().length > 0) {
      return result.value;
    }
  } catch (err: any) {
    console.warn("[FileParser] Mammoth docx extraction failed, trying zip XML heuristic:", err);
  }

  // Fallback: extract XML text from docx archive buffer
  try {
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(uint8);
    const textMatches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
    if (textMatches && textMatches.length > 0) {
      const extracted = textMatches.map((m) => m.replace(/<[^>]+>/g, "")).join(" ");
      return cleanWordDocText(extracted);
    }
  } catch (err: any) {
    console.warn("[FileParser] Zip XML fallback failed:", err);
  }

  return "[Could not extract text from DOCX file]";
}

async function extractPdfText(file: File): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist");
    if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      const version = pdfjsLib.version || "4.0.379";
      const isNewer = parseInt(version.split(".")[0]) >= 4;
      const workerUrl = isNewer
        ? `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`
        : `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.js`;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    }

    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
    const pdfDoc = await loadingTask.promise;

    const numPages = Math.min(pdfDoc.numPages, 50);
    let fullText = "";

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageStrings = textContent.items
        .map((item: any) => (item?.str ? item.str : ""))
        .filter(Boolean);
      fullText += `--- Page ${pageNum} ---\n` + pageStrings.join(" ") + "\n\n";
    }

    return fullText;
  } catch (err: any) {
    console.warn("[FileParser] PDFjs extraction failed, trying binary stream heuristic:", err);
    const buf = await file.arrayBuffer();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const raw = decoder.decode(buf);
    const matches = raw.match(/\(([^()]{2,})\)/g);
    if (matches && matches.length > 0) {
      return matches.map((m) => m.slice(1, -1)).join(" ");
    }
    return "[Could not extract text from PDF file]";
  }
}

export interface FormattedBubbleAttachment {
  name: string;
  sizeFormatted: string;
  format: string;
}

export interface FormattedUserBubble {
  attachments: FormattedBubbleAttachment[];
  displayText: string;
}

/**
 * Extracts and formats the user-facing bubble content so that raw code and
 * raw text of attached files NEVER spill into the chat bubble.
 * Displays only the clean snapshot badge: [Attached file: name, size, format].
 */
export function formatUserBubbleContent(m: ChatMessage): FormattedUserBubble {
  const attachments: FormattedBubbleAttachment[] = [];
  const text = m.text || "";
  const legacyBlockRegex =
    /\[ATTACHED FILE:\s*"([^"]+)"\s*(?:\(([^)]+)\))?\][\s\S]*?\[END OF FILE\s*"?\1"?\]/gi;

  // 1. Structured attachments
  if (m.attachments && m.attachments.length > 0) {
    for (const a of m.attachments) {
      const sizeKB = Math.round(a.size / 1024);
      attachments.push({
        name: a.name,
        sizeFormatted: `${sizeKB} KB`,
        format: a.format || (a.name.includes(".") ? a.name.slice(a.name.lastIndexOf(".") + 1) : "file"),
      });
    }
  }

  // 2. Embedded legacy blocks
  let match: RegExpExecArray | null;
  while ((match = legacyBlockRegex.exec(text)) !== null) {
    const name = match[1];
    // Only add if not already present via structured attachments
    if (!attachments.some((a) => a.name === name)) {
      const info = match[2] || "";
      let sizeFormatted = info;
      let format = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "file";

      if (info.includes(",")) {
        const parts = info.split(",");
        sizeFormatted = parts[0].trim();
        if (parts[1]) format = parts[1].replace(/format:\s*/i, "").trim();
      }

      attachments.push({
        name,
        sizeFormatted: sizeFormatted || "Attached",
        format,
      });
    }
  }

  // 3. Always strip the blocks from the display text
  const cleanText = text.replace(legacyBlockRegex, "").replace(/^User Message:\s*/i, "").trim();

  return {
    attachments,
    displayText: cleanText,
  };
}
