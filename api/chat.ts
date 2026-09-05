import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../server/workspaceStore.js";
import { askGeminiRag } from "../server/ragService.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wsId = getWorkspaceId(req);
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const { message } = body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  if (Array.isArray(body?.chunks) && body.chunks.length > 0) {
    const existingChunks = workspaceStore.getChunks(wsId);
    if (existingChunks.length === 0) {
      workspaceStore.addChunks(wsId, body.chunks);
    }
    const existingDocs = workspaceStore.getDocuments(wsId);
    if (existingDocs.length === 0) {
      const docMap = new Map<string, any>();
      for (const c of body.chunks) {
        if (!docMap.has(c.docId)) {
          docMap.set(c.docId, {
            id: c.docId,
            workspaceId: wsId,
            filename: c.filename,
            fileSize: 42000,
            totalPages: c.pageNumber || 1,
            totalChunks: 1,
            uploadedAt: new Date().toISOString(),
            status: "ready",
          });
        }
      }
      for (const doc of docMap.values()) {
        workspaceStore.addDocument(wsId, doc);
      }
    }
  }

  const userMsgId = `user_${Date.now()}`;
  const userMsg = {
    id: userMsgId,
    role: "user" as const,
    content: message.trim(),
    timestamp: new Date().toISOString(),
  };
  workspaceStore.addMessage(wsId, userMsg);

  try {
    const history = workspaceStore.getMessages(wsId);
    const { answer, sources } = await askGeminiRag(wsId, message.trim(), history);

    const modelMsgId = `model_${Date.now()}`;
    const modelMsg = {
      id: modelMsgId,
      role: "model" as const,
      content: answer,
      sources,
      timestamp: new Date().toISOString(),
    };
    workspaceStore.addMessage(wsId, modelMsg);

    res.json({
      answer,
      sources,
      messageId: modelMsgId,
    });
  } catch (err: any) {
    console.error("Chat generation error:", err);
    res.status(500).json({
      error: err?.message || "Failed to generate answer",
    });
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
  let reqBody = req.body;
  if (typeof reqBody === "string") {
    try { reqBody = JSON.parse(reqBody); } catch (e) {}
  }
  if (reqBody && typeof reqBody.workspaceId === "string" && reqBody.workspaceId.trim()) {
    return reqBody.workspaceId.trim();
  }
  return "default_workspace";
}
