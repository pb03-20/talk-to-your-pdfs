export interface DocumentMetadata {
  id: string;
  workspaceId?: string;
  filename: string;
  fileSize: number;
  totalPages: number;
  totalChunks: number;
  uploadedAt: string;
  status: "processing" | "ready" | "error";
  errorMessage?: string;
}

export interface SourceCitation {
  docId: string;
  filename: string;
  pageNumber: number;
  snippet: string;
  score?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "model";
  content: string;
  sources?: SourceCitation[];
  timestamp: string;
  isVoice?: boolean;
}

export interface WorkspaceInfo {
  workspaceId: string;
  documents: DocumentMetadata[];
  totalChunks: number;
  messages: ChatMessage[];
}
