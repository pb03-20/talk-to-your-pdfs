import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../../server/workspaceStore.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wsId = getWorkspaceId(req);
  const docId = req.query.docId;

  if (typeof docId !== "string") {
    return res.status(400).json({ error: "Document ID is required" });
  }

  const removed = workspaceStore.removeDocument(wsId, docId);
  if (!removed) {
    return res.status(404).json({ error: "Document not found" });
  }

  const ws = workspaceStore.getOrCreateWorkspace(wsId);
  res.json({
    success: true,
    documents: ws.documents,
    totalChunks: ws.chunks.length,
  });
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
  return "default_workspace";
}
