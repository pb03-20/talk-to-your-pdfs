import { WorkspaceData, DocumentMetadata, DocumentChunk, ChatMessage } from "./types.js";

class WorkspaceStore {
  private workspaces: Map<string, WorkspaceData> = new Map();

  constructor() {
    // Note: In serverless environments, cleanup happens naturally when
    // function instances are recycled. setInterval is only useful in
    // long-running server mode.
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

  public getOrCreateWorkspace(workspaceId: string): WorkspaceData {
    let ws = this.workspaces.get(workspaceId);
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
    }
    return ws;
  }

  public getWorkspace(workspaceId: string): WorkspaceData | undefined {
    return this.workspaces.get(workspaceId);
  }

  public getDocuments(workspaceId: string): DocumentMetadata[] {
    const ws = this.getOrCreateWorkspace(workspaceId);
    return ws.documents;
  }

  public addDocument(workspaceId: string, doc: DocumentMetadata): void {
    const ws = this.getOrCreateWorkspace(workspaceId);
    // Replace if existing
    ws.documents = ws.documents.filter((d) => d.id !== doc.id);
    ws.documents.push(doc);
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
    }
  }

  public addChunks(workspaceId: string, chunks: DocumentChunk[]): void {
    const ws = this.getOrCreateWorkspace(workspaceId);
    ws.chunks.push(...chunks);
  }

  public removeDocument(workspaceId: string, docId: string): boolean {
    const ws = this.getWorkspace(workspaceId);
    if (!ws) return false;
    ws.documents = ws.documents.filter((d) => d.id !== docId);
    ws.chunks = ws.chunks.filter((c) => c.docId !== docId);
    return true;
  }

  public clearWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
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
  }

  public clearMessages(workspaceId: string): void {
    const ws = this.getWorkspace(workspaceId);
    if (ws) {
      ws.messages = [];
    }
  }

  private cleanupOldWorkspaces(): void {
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000;
    for (const [id, ws] of this.workspaces.entries()) {
      const created = new Date(ws.createdAt).getTime();
      if (now - created > maxAgeMs) {
        this.workspaces.delete(id);
      }
    }
  }
}

export const workspaceStore = new WorkspaceStore();
