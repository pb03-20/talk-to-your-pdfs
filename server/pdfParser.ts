import { DocumentChunk } from "./types.js";
// @ts-ignore
import { PDFParse } from "pdf-parse";

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
 * Extracts text page-by-page from a PDF buffer.
 */
export async function extractPdfText(buffer: Buffer): Promise<ParseResult> {
  try {
    const parser = new PDFParse({ data: buffer });
    const textData = await parser.getText();
    await parser.destroy();

    const pages: ExtractedPage[] = [];
    if (textData && Array.isArray(textData.pages) && textData.pages.length > 0) {
      for (const p of textData.pages) {
        const cleanText = (p.text || "").trim();
        if (cleanText) {
          pages.push({
            pageNumber: p.num || pages.length + 1,
            text: cleanText,
          });
        }
      }
    }

    // Fallback if pages array is empty but raw text exists
    if (pages.length === 0 && textData?.text) {
      pages.push({
        pageNumber: 1,
        text: textData.text.trim(),
      });
    }

    const totalPages = pages.length > 0 ? pages.length : textData?.total || 1;
    const rawText = pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join("\n\n");

    return {
      totalPages,
      pages,
      rawText,
    };
  } catch (err: any) {
    console.error("Error parsing PDF with PDFParse:", err);
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

    // Split page by paragraphs or sentences
    let startIdx = 0;
    while (startIdx < text.length) {
      let endIdx = Math.min(startIdx + chunkSize, text.length);

      // Try to break on a sentence boundary or newline if not at end
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
