import React, { useState, useRef, useEffect } from "react";
import { Mic, Menu, Trash2, Sun, Moon, MonitorSmartphone, FileText, LogOut, ChevronDown, User as UserIcon } from "lucide-react";
import { DocumentMetadata, AuthUser } from "../types";
import { ThemePreference } from "../lib/theme";
import { GoogleIcon } from "./LoginPage";

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
  user: AuthUser | null;
  onSignOut: () => void;
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
  user,
  onSignOut,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const readyDocs = documents.filter((d) => d.status === "ready");
  const ThemeIcon =
    themePreference === "light" ? Sun : themePreference === "dark" ? Moon : MonitorSmartphone;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    if (isMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isMenuOpen]);

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "G";

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

      <div className="flex items-center gap-1.5 shrink-0">
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

        <div className="w-px h-5 bg-line mx-0.5" aria-hidden="true" />

        <button
          id="btn-header-voice"
          onClick={onOpenVoice}
          className={`flex items-center gap-2 pl-3 pr-3.5 py-1.5 rounded-[10px] text-[13px] font-medium transition-colors ${
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

        {/* User Account / Google Profile */}
        {user ? (
          <div className="relative ml-1" ref={menuRef}>
            <button
              id="btn-header-user-menu"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              className="flex items-center gap-1.5 p-1 rounded-full hover:ring-2 hover:ring-line transition-all"
              aria-label="User account menu"
            >
              {user.picture ? (
                <img
                  src={user.picture}
                  alt={user.name}
                  className="w-7 h-7 rounded-full object-cover border border-line"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white text-[11px] font-semibold flex items-center justify-center">
                  {initials}
                </div>
              )}
              <ChevronDown className="w-3 h-3 text-ink-3" />
            </button>

            {/* Account Popover Menu */}
            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-64 bg-surface border border-line rounded-2xl shadow-xl p-3 z-50 animate-in fade-in slide-in-from-top-1">
                <div className="flex items-center gap-3 pb-3 border-b border-line">
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt={user.name}
                      className="w-10 h-10 rounded-full object-cover border border-line"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-semibold flex items-center justify-center text-sm">
                      {initials}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-ink truncate">{user.name}</p>
                    <p className="text-[11px] text-ink-3 truncate">{user.email}</p>
                  </div>
                </div>

                <div className="py-2.5 px-1 border-b border-line">
                  <div className="flex items-center gap-2 text-[11.5px] text-ink-2">
                    <GoogleIcon className="w-4 h-4 shrink-0" />
                    <span className="font-medium text-ink">Google Account</span>
                    <span className="ml-auto text-[10px] font-semibold text-positive bg-positive-bg px-1.5 py-0.5 rounded">
                      Free
                    </span>
                  </div>
                  <p className="text-[10.5px] text-ink-3 mt-1 pl-6">
                    Active authenticated session
                  </p>
                </div>

                <div className="pt-2">
                  <button
                    id="btn-header-signout"
                    onClick={() => {
                      setIsMenuOpen(false);
                      onSignOut();
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-critical hover:bg-critical-bg transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sign out / Switch Account</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </header>
  );
};
