import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../server/workspaceStore.js";
import { chunkDocumentPages } from "../server/pdfParser.js";
import { embedChunks } from "../server/ragService.js";
import { SAMPLE_DOCUMENT } from "../server/sampleDoc.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wsId = getWorkspaceId(req);
  const docId = `sample_${Date.now()}`;

  workspaceStore.addDocument(wsId, {
    id: docId,
    workspaceId: wsId,
    filename: SAMPLE_DOCUMENT.filename,
    fileSize: 42000,
    totalPages: SAMPLE_DOCUMENT.totalPages,
    totalChunks: 0,
    uploadedAt: new Date().toISOString(),
    status: "processing",
  });

  try {
    const chunks = chunkDocumentPages(
      wsId,
      docId,
      SAMPLE_DOCUMENT.filename,
      SAMPLE_DOCUMENT.pages,
      700,
      100
    );

    await embedChunks(chunks);
    workspaceStore.addChunks(wsId, chunks);
    workspaceStore.updateDocumentStatus(wsId, docId, "ready", chunks.length, SAMPLE_DOCUMENT.totalPages);

    const ws = workspaceStore.getOrCreateWorkspace(wsId);
    res.json({
      success: true,
      document: ws.documents.find((d) => d.id === docId),
      totalChunks: ws.chunks.length,
    });
  } catch (err: any) {
    console.error("Error loading sample document:", err);
    res.status(500).json({ error: err?.message || "Failed to load sample document" });
  }
}

function getWorkspaceId(req: VercelRequest): string {
  const wsHeader = req.headers["x-workspace-id"];
  if (typeof wsHeader === "string" && wsHeader.trim()) {
    return wsHeader.trim();
  }
  const queryWsId = req.query.workspaceId;
  if (typeof queryWsId === "string" && queryWsId.trim()) {
    return queryWsId.trim();
  }
  if (req.body && typeof req.body.workspaceId === "string" && req.body.workspaceId.trim()) {
    return req.body.workspaceId.trim();
  }
  return "default_workspace";
}
