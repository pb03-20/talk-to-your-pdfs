import { WorkspaceData, DocumentMetadata, DocumentChunk, ChatMessage } from "./types.js";
import fs from "fs";
import path from "path";
import os from "os";

function getTmpPath(workspaceId: string): string {
  const sanitized = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `rag_ws_${sanitized}.json`);
}

class WorkspaceStore {
  private workspaces: Map<string, WorkspaceData> = new Map();

  constructor() {
    if (typeof globalThis !== "undefined" && !(globalThis as any).__workspaceCleanupSet) {
      try {
        setInterval(() => {
          this.cleanupOldWorkspaces();
        }, 1000 * 60 * 60);
        (globalThis as any).__workspaceCleanupSet = true;
      } catch {
        // Ignore — serverless environment may not support setInterval
      }
    }
  }

  private persistToDisk(workspaceId: string): void {
    try {
      const ws = this.workspaces.get(workspaceId);
      if (!ws) return;
      const filePath = getTmpPath(workspaceId);
      fs.writeFileSync(filePath, JSON.stringify(ws), "utf-8");
    } catch (err) {
      console.warn("Failed to persist workspace to /tmp disk:", err);
    }
  }

  private loadFromDisk(workspaceId: string): WorkspaceData | null {
    try {
      const filePath = getTmpPath(workspaceId);
      if (fs.existsSync(filePath)) {
        const dataStr = fs.readFileSync(filePath, "utf-8");
        const ws = JSON.parse(dataStr) as WorkspaceData;
        if (ws && ws.id) {
          this.workspaces.set(workspaceId, ws);
          return ws;
        }
      }
    } catch (err) {
      console.warn("Failed to load workspace from /tmp disk:", err);
    }
    return null;
  }

  public getOrCreateWorkspace(workspaceId: string): WorkspaceData {
    let ws = this.workspaces.get(workspaceId);
    if (!ws) {
      ws = this.loadFromDisk(workspaceId) || undefined;
    }
    if (!ws) {
      ws = {
        id: workspaceId,
        createdAt: new Date().toISOString(),
        documents: [],
        chunks: [],
        messages: [
          {
            id: "welcome-msg",
            role: "model",
            content: "Hello! Upload your PDFs in the sidebar, and I'll analyze, index, and answer any questions with exact page references. You can also press the microphone button to talk through your documents in real-time.",
            timestamp: new Date().toISOString(),
          },
        ],
      };
      this.workspaces.set(workspaceId, ws);
      this.persistToDisk(workspaceId);
    }
    return ws;
  }

  public getWorkspace(workspaceId: string): WorkspaceData | undefined {
    let ws = this.workspaces.get(workspaceId);
    if (!ws) {
      ws = this.loadFromDisk(workspaceId) || undefined;
    }
    return ws;
  }

  public getDocuments(workspaceId: string): DocumentMetadata[] {
    const ws = this.getOrCreateWorkspace(workspaceId);
    return ws.documents;
  }

  public addDocument(workspaceId: string, doc: DocumentMetadata): void {
    const ws = this.getOrCreateWorkspace(workspaceId);
    ws.documents = ws.documents.filter((d) => d.id !== doc.id);
    ws.documents.push(doc);
    this.persistToDisk(workspaceId);
  }

  public updateDocumentStatus(
    workspaceId: string,
    docId: string,
    status: DocumentMetadata["status"],
    totalChunks?: number,
    totalPages?: number,
    errorMessage?: string
  ): void {
    const ws = this.getOrCreateWorkspace(workspaceId);
    const doc = ws.documents.find((d) => d.id === docId);
    if (doc) {
      doc.status = status;
      if (typeof totalChunks === "number") doc.totalChunks = totalChunks;
      if (typeof totalPages === "number") doc.totalPages = totalPages;
      if (errorMessage) doc.errorMessage = errorMessage;
      this.persistToDisk(workspaceId);
    }
  }

  public addChunks(workspaceId: string, chunks: DocumentChunk[]): void {
    const ws = this.getOrCreateWorkspace(workspaceId);
    ws.chunks.push(...chunks);
    this.persistToDisk(workspaceId);
  }

  public removeDocument(workspaceId: string, docId: string): boolean {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return false;
    ws.documents = ws.documents.filter((d) => d.id !== docId);
    ws.chunks = ws.chunks.filter((c) => c.docId !== docId);
    this.persistToDisk(workspaceId);
    return true;
  }

  public clearWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
    try {
      const filePath = getTmpPath(workspaceId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }

  public getChunks(workspaceId: string): DocumentChunk[] {
    const ws = this.getWorkspace(workspaceId);
    return ws ? ws.chunks : [];
  }

  public getMessages(workspaceId: string): ChatMessage[] {
    const ws = this.getOrCreateWorkspace(workspaceId);
    return ws.messages;
  }

  public addMessage(workspaceId: string, message: ChatMessage): void {
    const ws = this.getOrCreateWorkspace(workspaceId);
    ws.messages.push(message);
    this.persistToDisk(workspaceId);
  }

  public clearMessages(workspaceId: string): void {
    const ws = this.getWorkspace(workspaceId);
    if (ws) {
      ws.messages = [];
      this.persistToDisk(workspaceId);
    }
  }

  private cleanupOldWorkspaces(): void {
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000;
    for (const [id, ws] of this.workspaces.entries()) {
      const created = new Date(ws.createdAt).getTime();
      if (now - created > maxAgeMs) {
        this.clearWorkspace(id);
      }
    }
  }
}

export const workspaceStore = new WorkspaceStore();
