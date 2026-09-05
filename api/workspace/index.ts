import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../../server/workspaceStore.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wsId = getWorkspaceId(req);
  const ws = workspaceStore.getOrCreateWorkspace(wsId);

  res.json({
    workspaceId: ws.id,
    documents: ws.documents,
    chunks: ws.chunks,
    totalChunks: ws.chunks.length,
    messages: ws.messages,
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
