import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../server/workspaceStore.js";
import { extractPdfText, chunkDocumentPages } from "../server/pdfParser.js";
import { embedChunks } from "../server/ragService.js";
import Busboy from "busboy";

export const config = {
  api: {
    bodyParser: false, // Disable default body parser for file uploads
  },
};

// Vercel rejects request bodies above 4.5 MB before this handler runs. Keep
// this limit aligned with the client-side guard, while allowing the local
// Express server to retain its larger upload allowance.
const MAX_FILE_SIZE = process.env.VERCEL ? 4 * 1024 * 1024 : 100 * 1024 * 1024;

interface ParsedFile {
  fieldname: string;
  filename: string;
  buffer: Buffer;
  size: number;
}

function parseMultipart(req: VercelRequest): Promise<{ files: ParsedFile[]; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const files: ParsedFile[] = [];
    const fields: Record<string, string> = {};

    const busboy = Busboy({
      headers: req.headers as Record<string, string>,
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 30,
      },
    });

    busboy.on("file", (fieldname: string, stream: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        files.push({
          fieldname,
          filename: info.filename,
          buffer,
          size: buffer.length,
        });
      });
    });

    busboy.on("field", (name: string, value: string) => {
      fields[name] = value;
    });

    busboy.on("finish", () => resolve({ files, fields }));
    busboy.on("error", (err: Error) => reject(err));

    req.pipe(busboy as any);
  });
}

function getWorkspaceId(req: VercelRequest, fields?: Record<string, string>): string {
  const wsHeader = req.headers["x-workspace-id"];
  if (typeof wsHeader === "string" && wsHeader.trim()) {
    return wsHeader.trim();
  }
  const queryWsId = req.query.workspaceId;
  if (typeof queryWsId === "string" && queryWsId.trim()) {
    return queryWsId.trim();
  }
  if (fields && typeof fields.workspaceId === "string" && fields.workspaceId.trim()) {
    return fields.workspaceId.trim();
  }
  return "default_workspace";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { files, fields } = await parseMultipart(req);
    const wsId = getWorkspaceId(req, fields);

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const results = [];

    for (const file of files) {
      const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const filename = Buffer.from(file.filename, "latin1").toString("utf8");

      workspaceStore.addDocument(wsId, {
        id: docId,
        workspaceId: wsId,
        filename,
        fileSize: file.size,
        totalPages: 0,
        totalChunks: 0,
        uploadedAt: new Date().toISOString(),
        status: "processing",
      });

      try {
        const parseResult = await extractPdfText(file.buffer);
        const chunks = chunkDocumentPages(wsId, docId, filename, parseResult.pages, 700, 100);
        await embedChunks(chunks);
        workspaceStore.addChunks(wsId, chunks);
        workspaceStore.updateDocumentStatus(wsId, docId, "ready", chunks.length, parseResult.totalPages);

        results.push({
          docId,
          filename,
          pages: parseResult.totalPages,
          chunks: chunks.length,
          status: "ready",
        });
      } catch (err: any) {
        console.error(`Error processing file ${filename}:`, err);
        workspaceStore.updateDocumentStatus(wsId, docId, "error", 0, 0, err?.message || "Failed to parse PDF");
        results.push({
          docId,
          filename,
          status: "error",
          error: err?.message || "Parsing error",
        });
      }
    }

    const updatedWs = workspaceStore.getOrCreateWorkspace(wsId);
    res.json({
      success: true,
      processed: results,
      documents: updatedWs.documents,
      totalChunks: updatedWs.chunks.length,
    });
  } catch (err: any) {
    console.error("Upload handler error:", err);
    res.status(500).json({ error: err?.message || "Upload failed" });
  }
}
