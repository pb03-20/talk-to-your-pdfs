import React from "react";
import { Mic, Menu, Trash2, Sun, Moon, MonitorSmartphone, FileText } from "lucide-react";
import { DocumentMetadata } from "../types";
import { ThemePreference } from "../lib/theme";

interface HeaderProps {
  workspaceId: string;
  documents: DocumentMetadata[];
  onOpenVoice: () => void;
  onClearChat: () => void;
  onResetWorkspace: () => void;
  onToggleSidebar: () => void;
  isVoiceActive?: boolean;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
}

const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Light theme",
  dark: "Dark theme",
  system: "Matching system theme",
};

export const Header: React.FC<HeaderProps> = ({
  documents,
  onOpenVoice,
  onClearChat,
  onToggleSidebar,
  isVoiceActive = false,
  themePreference,
  onCycleTheme,
}) => {
  const readyDocs = documents.filter((d) => d.status === "ready");
  const ThemeIcon =
    themePreference === "light" ? Sun : themePreference === "dark" ? Moon : MonitorSmartphone;

  return (
    <header className="h-14 shrink-0 border-b border-line bg-surface/85 backdrop-blur-xl px-3 sm:px-5 flex items-center justify-between gap-3 sticky top-0 z-20">
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          id="btn-toggle-sidebar"
          onClick={onToggleSidebar}
          className="md:hidden p-2 -ml-1 text-ink-2 hover:text-ink hover:bg-sunken rounded-lg transition-colors"
          aria-label="Toggle documents sidebar"
        >
          <Menu className="w-[18px] h-[18px]" />
        </button>

        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-[10px] bg-accent text-accent-ink flex items-center justify-center shrink-0">
            <FileText className="w-[17px] h-[17px]" strokeWidth={2.1} />
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-ink tracking-[-0.011em] leading-tight truncate">
              Talk to Your PDFs
            </h1>
            <p className="text-[11.5px] text-ink-3 leading-tight truncate">
              {readyDocs.length === 0
                ? "No documents indexed"
                : `${readyDocs.length} document${readyDocs.length === 1 ? "" : "s"} indexed`}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          id="btn-header-theme"
          onClick={onCycleTheme}
          title={`${THEME_LABEL[themePreference]} — click to change`}
          aria-label={`${THEME_LABEL[themePreference]} — click to change`}
          className="p-2 text-ink-3 hover:text-ink hover:bg-sunken rounded-lg transition-colors"
        >
          <ThemeIcon className="w-[17px] h-[17px]" />
        </button>

        <button
          id="btn-header-clear-chat"
          onClick={onClearChat}
          title="Clear chat history"
          aria-label="Clear chat history"
          className="p-2 text-ink-3 hover:text-critical hover:bg-critical-bg rounded-lg transition-colors"
        >
          <Trash2 className="w-[17px] h-[17px]" />
        </button>

        <div className="w-px h-5 bg-line mx-1" aria-hidden="true" />

        <button
          id="btn-header-voice"
          onClick={onOpenVoice}
          className={`flex items-center gap-2 pl-3 pr-3.5 py-2 rounded-[10px] text-[13px] font-medium transition-colors ${
            isVoiceActive
              ? "bg-critical-bg text-critical"
              : "bg-accent hover:bg-accent-hover text-accent-ink"
          }`}
        >
          <span className="relative flex items-center justify-center">
            <Mic className="w-4 h-4" strokeWidth={2.2} />
            {isVoiceActive && (
              <span className="absolute -top-1 -right-1.5 w-1.5 h-1.5 rounded-full bg-critical animate-pulse" />
            )}
          </span>
          <span className="hidden sm:inline">{isVoiceActive ? "Live" : "Voice"}</span>
        </button>
      </div>
    </header>
  );
};
