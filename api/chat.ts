import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../server/workspaceStore.js";
import { askGeminiRag } from "../server/ragService.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wsId = getWorkspaceId(req);
  const { message } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
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
  if (req.body && typeof req.body.workspaceId === "string" && req.body.workspaceId.trim()) {
    return req.body.workspaceId.trim();
  }
  return "default_workspace";
}
