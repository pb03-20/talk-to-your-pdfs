/**
 * Talk to Your PDFs - Full-Stack RAG & Gemini Live Voice Web App
 */

import React, { useState, useEffect, useRef } from "react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { ChatArea } from "./components/ChatArea";
import { VoiceModal } from "./components/VoiceModal";
import { CitationModal } from "./components/CitationModal";
import { DocumentMetadata, DocumentChunk, ChatMessage, SourceCitation } from "./types";
import { LiveAudioPlayer, speakWithBrowser } from "./lib/audioUtils";

function getOrInitWorkspaceId(): string {
  const key = "pdf_rag_workspace_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export default function App() {
  const [workspaceId, setWorkspaceId] = useState<string>(getOrInitWorkspaceId);
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [workspaceChunks, setWorkspaceChunks] = useState<DocumentChunk[]>([]);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);
  const [isVoiceOpen, setIsVoiceOpen] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [selectedCitation, setSelectedCitation] = useState<SourceCitation | null>(null);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const ttsPlayerRef = useRef<LiveAudioPlayer | null>(null);

  // Fetch workspace state
  const loadWorkspace = async (idToLoad: string) => {
    try {
      const res = await fetch("/api/workspace", {
        headers: {
          "x-workspace-id": idToLoad,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
        setTotalChunks(data.totalChunks || 0);
        if (data.chunks) setWorkspaceChunks(data.chunks);
        setMessages(data.messages || []);
      }
    } catch (err) {
      console.error("Failed to fetch workspace:", err);
    }
  };

  useEffect(() => {
    loadWorkspace(workspaceId);
  }, [workspaceId]);

  // Upload Multiple PDFs
  const handleUploadFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setUploadError(null);

    const fileList = Array.from(files);

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB max per file for FastAPI & Cloudflare Tunnel
    const oversized = fileList.find((f) => f.size > MAX_FILE_SIZE);
    if (oversized) {
      const sizeMB = (oversized.size / (1024 * 1024)).toFixed(1);
      setUploadError(
        `"${oversized.name}" is ${sizeMB}MB. Maximum supported PDF size is 100MB per file.`
      );
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      formData.append("files", fileList[i]);
    }

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: {
          "x-workspace-id": workspaceId,
        },
        body: formData,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Upload failed with status: ${res.status}`);
      }

      const data = await res.json();
      if (data.documents) {
        setDocuments(data.documents);
        setTotalChunks(data.totalChunks || 0);
      }
    } catch (err: any) {
      console.error("Upload error:", err);
      setUploadError(err?.message || "Upload failed. Please check the file and try again.");
    } finally {
      setIsUploading(false);
    }
  };

  // Load sample PDF
  const handleLoadSampleDoc = async () => {
    setIsUploading(true);
    try {
      const res = await fetch("/api/sample-doc", {
        method: "POST",
        headers: {
          "x-workspace-id": workspaceId,
        },
      });

      if (!res.ok) {
        throw new Error("Failed to load sample document");
      }

      const data = await res.json();
      if (data.documents) setDocuments(data.documents);
      if (data.chunks) setWorkspaceChunks(data.chunks);
      if (data.totalChunks) setTotalChunks(data.totalChunks);

      await loadWorkspace(workspaceId);
    } catch (err: any) {
      console.error("Sample document loading error:", err);
      alert(`Could not load sample document: ${err?.message || "Error"}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Delete a document
  const handleDeleteDocument = async (docId: string) => {
    try {
      const res = await fetch(`/api/documents/${docId}`, {
        method: "DELETE",
        headers: {
          "x-workspace-id": workspaceId,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
        setTotalChunks(data.totalChunks || 0);
        setWorkspaceChunks((prev) => prev.filter((c) => c.docId !== docId));
      }
    } catch (err) {
      console.error("Failed to delete document:", err);
    }
  };

  // Reset / Clear workspace
  const handleResetWorkspace = async () => {
    if (!confirm("Are you sure you want to reset this workspace? All uploaded documents and chat history will be permanently cleared.")) {
      return;
    }

    const newId = `ws_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem("pdf_rag_workspace_id", newId);
    setWorkspaceId(newId);
    setDocuments([]);
    setWorkspaceChunks([]);
    setTotalChunks(0);
    setMessages([
      {
        id: "new-ws-msg",
        role: "model",
        content: "Workspace reset. You have a fresh, isolated workspace. Upload PDFs in the sidebar to start asking questions or click 'Load Sample PDF'.",
        timestamp: new Date().toISOString(),
      },
    ]);
  };

  // Clear chat history only
  const handleClearChat = async () => {
    try {
      await fetch("/api/workspace/clear-chat", {
        method: "POST",
        headers: { "x-workspace-id": workspaceId },
      });
      setMessages([]);
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  // Send question to Gemini RAG
  const handleSendMessage = async (text: string) => {
    const tempUserMsgId = `user_${Date.now()}`;
    const userMsg: ChatMessage = {
      id: tempUserMsgId,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsChatLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": workspaceId,
        },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with status ${res.status}`);
      }

      const data = await res.json();
      const modelMsg: ChatMessage = {
        id: data.messageId || `model_${Date.now()}`,
        role: "model",
        content: data.answer,
        sources: data.sources || [],
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, modelMsg]);
    } catch (err: any) {
      console.error("Chat error:", err);
      const errorMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        role: "model",
        content: `Sorry, I encountered an error answering your question: ${err?.message || "Please check your network and try again."}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // TTS Read Aloud
  const handlePlayTTS = async (text: string) => {
    if (ttsPlayerRef.current) {
      ttsPlayerRef.current.stop();
    }

    setPlayingMessageId("loading");

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.audio) {
          if (!ttsPlayerRef.current) {
            ttsPlayerRef.current = new LiveAudioPlayer();
          }
          ttsPlayerRef.current.playChunk(data.audio);
          setPlayingMessageId("playing");
          return;
        }
      }
      // Browser fallback if server TTS unavailable
      speakWithBrowser(text, () => setPlayingMessageId(null));
      setPlayingMessageId("playing");
    } catch (e) {
      speakWithBrowser(text, () => setPlayingMessageId(null));
      setPlayingMessageId("playing");
    }
  };

  const handleStopTTS = () => {
    if (ttsPlayerRef.current) {
      ttsPlayerRef.current.stop();
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingMessageId(null);
  };

  return (
    <div className="h-screen w-full flex flex-col bg-white overflow-hidden text-zinc-900 font-sans antialiased">
      {/* Top Header */}
      <Header
        workspaceId={workspaceId}
        documents={documents}
        onOpenVoice={() => setIsVoiceOpen(true)}
        onClearChat={handleClearChat}
        onResetWorkspace={handleResetWorkspace}
        onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
        isVoiceActive={isVoiceOpen}
      />

      {/* Main Container */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Sidebar: PDF Upload & Document Management */}
        <Sidebar
          documents={documents}
          totalChunks={totalChunks}
          isUploading={isUploading}
          uploadError={uploadError}
          onDismissUploadError={() => setUploadError(null)}
          onUploadFiles={handleUploadFiles}
          onLoadSampleDoc={handleLoadSampleDoc}
          onDeleteDocument={handleDeleteDocument}
          onResetWorkspace={handleResetWorkspace}
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
        />

        {/* Center/Right Area: Chat, Input, Citations */}
        <ChatArea
          messages={messages}
          onSendMessage={handleSendMessage}
          isLoading={isChatLoading}
          onOpenVoice={() => setIsVoiceOpen(true)}
          hasDocuments={documents.length > 0}
          onSelectCitation={(cit) => setSelectedCitation(cit)}
          onPlayTTS={handlePlayTTS}
          playingMessageId={playingMessageId}
          onStopTTS={handleStopTTS}
        />
      </div>

      {/* Gemini Live Voice Modal */}
      <VoiceModal
        isOpen={isVoiceOpen}
        onClose={() => setIsVoiceOpen(false)}
        workspaceId={workspaceId}
        documentsCount={documents.length}
      />

      {/* Detailed Citation Inspector Modal */}
      <CitationModal
        citation={selectedCitation}
        onClose={() => setSelectedCitation(null)}
      />
    </div>
  );
}
