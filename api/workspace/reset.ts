import type { VercelRequest, VercelResponse } from "@vercel/node";
import { workspaceStore } from "../../server/workspaceStore.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wsId = getWorkspaceId(req);
  workspaceStore.clearWorkspace(wsId);
  const newWs = workspaceStore.getOrCreateWorkspace(wsId);

  res.json({
    success: true,
    message: "Workspace cleared successfully.",
    workspace: newWs,
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
  if (req.body && typeof req.body.workspaceId === "string" && req.body.workspaceId.trim()) {
    return req.body.workspaceId.trim();
  }
  return "default_workspace";
}
