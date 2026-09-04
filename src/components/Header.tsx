import React from "react";
import { Mic, FileText, Trash2, Menu, Sparkles, Plus, Volume2 } from "lucide-react";
import { DocumentMetadata } from "../types";

interface HeaderProps {
  workspaceId: string;
  documents: DocumentMetadata[];
  onOpenVoice: () => void;
  onClearChat: () => void;
  onResetWorkspace: () => void;
  onToggleSidebar: () => void;
  isVoiceActive?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  workspaceId,
  documents,
  onOpenVoice,
  onClearChat,
  onResetWorkspace,
  onToggleSidebar,
  isVoiceActive = false,
}) => {
  const readyDocs = documents.filter((d) => d.status === "ready");

  return (
    <header className="h-16 border-b border-zinc-200 bg-white/95 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between z-10 sticky top-0">
      <div className="flex items-center space-x-3">
        <button
          id="btn-toggle-sidebar"
          onClick={onToggleSidebar}
          className="md:hidden p-2 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors"
          aria-label="Toggle Documents Sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2.5">
          <div className="w-9 h-9 rounded-xl bg-zinc-900 flex items-center justify-center text-white shadow-sm">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-base font-semibold text-zinc-900 tracking-tight">
                Talk to Your PDFs
              </h1>
              <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                Gemini RAG + Live
              </span>
            </div>
            <div className="flex items-center space-x-2 text-xs text-zinc-500">
              <span>Workspace:</span>
              <code className="font-mono text-zinc-700 bg-zinc-100 px-1.5 py-0.5 rounded text-[11px]">
                {workspaceId.slice(0, 14)}...
              </code>
              <span className="text-zinc-300">•</span>
              <span className="text-zinc-600 font-medium">
                {readyDocs.length} {readyDocs.length === 1 ? "PDF" : "PDFs"} indexed
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center space-x-2 sm:space-x-3">
        <button
          id="btn-header-voice"
          onClick={onOpenVoice}
          className={`flex items-center space-x-2 px-3 sm:px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-xs ${
            isVoiceActive
              ? "bg-rose-500 text-white animate-pulse"
              : "bg-zinc-900 hover:bg-zinc-800 text-white"
          }`}
        >
          <Mic className="w-4 h-4" />
          <span className="hidden sm:inline">Voice Mode</span>
          {isVoiceActive && <span className="w-2 h-2 rounded-full bg-white animate-ping" />}
        </button>

        <button
          id="btn-header-clear-chat"
          onClick={onClearChat}
          title="Clear Chat History"
          className="p-2 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-lg transition-colors"
          aria-label="Clear Chat"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
