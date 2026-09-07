export interface DocumentMetadata {
  id: string;
  workspaceId: string;
  filename: string;
  fileSize: number;
  totalPages: number;
  totalChunks: number;
  uploadedAt: string;
  status: "processing" | "ready" | "error";
  errorMessage?: string;
}

export interface DocumentChunk {
  id: string;
  workspaceId: string;
  docId: string;
  filename: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  embedding?: number[];
  /** Which vector space `embedding` belongs to; only like-for-like compares. */
  embeddingKind?: "remote" | "local";
}

export interface ChatMessage {
  id: string;
  role: "user" | "model";
  content: string;
  sources?: SourceCitation[];
  timestamp: string;
}

export interface SourceCitation {
  docId: string;
  filename: string;
  pageNumber: number;
  snippet: string;
  score?: number;
}

export interface WorkspaceData {
  id: string;
  createdAt: string;
  documents: DocumentMetadata[];
  chunks: DocumentChunk[];
  messages: ChatMessage[];
}
