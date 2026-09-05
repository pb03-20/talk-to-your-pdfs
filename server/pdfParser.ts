import { DocumentChunk } from "./types.js";
// @ts-ignore
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export interface ExtractedPage {
  pageNumber: number;
  text: string;
}

export interface ParseResult {
  totalPages: number;
  pages: ExtractedPage[];
  rawText: string;
}

/**
 * Extracts text page-by-page from a PDF buffer using pdf-parse v1.
 */
export async function extractPdfText(buffer: Buffer): Promise<ParseResult> {
  try {
    const pages: ExtractedPage[] = [];
    let pageNumCounter = 0;

    // Custom pagerender to capture text per page
    const options = {
      pagerender: async function (pageData: any) {
        pageNumCounter++;
        const textContent = await pageData.getTextContent();
        let lastY: number | null = null;
        let text = "";
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || lastY === null) {
            text += item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }
        const cleanText = text.trim();
        if (cleanText) {
          pages.push({
            pageNumber: pageNumCounter,
            text: cleanText,
          });
        }
        return text;
      },
    };

    const data = await pdfParse(buffer, options);

    // Fallback if custom page render didn't populate pages
    if (pages.length === 0 && data.text) {
      const rawLines = data.text.split("\n");
      pages.push({
        pageNumber: 1,
        text: rawLines.join("\n").trim(),
      });
    }

    const totalPages = data.numpages || pages.length || 1;
    const rawText = pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join("\n\n");

    return {
      totalPages,
      pages,
      rawText,
    };
  } catch (err: any) {
    console.error("Error parsing PDF with pdf-parse:", err);
    throw new Error(`Failed to extract text from PDF: ${err?.message || "Unknown error"}`);
  }
}

/**
 * Chunks page text with overlap and tracks page numbers.
 */
export function chunkDocumentPages(
  workspaceId: string,
  docId: string,
  filename: string,
  pages: ExtractedPage[],
  chunkSize: number = 700,
  overlap: number = 100
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let chunkCounter = 0;

  for (const page of pages) {
    const text = page.text.replace(/\r\n/g, "\n");
    if (!text || text.trim().length === 0) continue;

    let startIdx = 0;
    while (startIdx < text.length) {
      let endIdx = Math.min(startIdx + chunkSize, text.length);

      if (endIdx < text.length) {
        const nextPeriod = text.indexOf(". ", endIdx - 80);
        const nextNewline = text.indexOf("\n\n", endIdx - 80);
        if (nextNewline !== -1 && nextNewline <= endIdx + 80) {
          endIdx = nextNewline + 2;
        } else if (nextPeriod !== -1 && nextPeriod <= endIdx + 80) {
          endIdx = nextPeriod + 2;
        }
      }

      const chunkText = text.slice(startIdx, endIdx).trim();
      if (chunkText.length > 30) {
        chunkCounter++;
        chunks.push({
          id: `${docId}_chunk_${chunkCounter}`,
          workspaceId,
          docId,
          filename,
          pageNumber: page.pageNumber,
          chunkIndex: chunkCounter,
          text: chunkText,
        });
      }

      if (endIdx >= text.length) break;
      startIdx = Math.max(startIdx + 1, endIdx - overlap);
    }
  }

  return chunks;
}
