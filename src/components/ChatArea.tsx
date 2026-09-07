import React, { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  Mic,
  BookOpen,
  Volume2,
  VolumeX,
  ChevronDown,
  FileText,
  Copy,
  Check,
  Loader2,
  Sparkles,
} from "lucide-react";
import { ChatMessage, SourceCitation } from "../types";
import { Markdown } from "../lib/markdown";

interface ChatAreaProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  onOpenVoice: () => void;
  hasDocuments: boolean;
  onSelectCitation?: (citation: SourceCitation) => void;
  onPlayTTS?: (text: string, messageId: string) => void;
  playingMessageId?: string | null;
  loadingTtsMessageId?: string | null;
  onStopTTS?: () => void;
}

/**
 * Generic starters. These used to name facts from the bundled sample
 * whitepaper, which was misleading once that sample was removed and people
 * were asking about their own PDFs.
 */
const STARTER_PROMPTS = [
  "Summarise the key points of this document.",
  "What are the main conclusions?",
  "List the important dates and figures mentioned.",
  "Explain the methodology in simple terms.",
];

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  onSendMessage,
  isLoading,
  onOpenVoice,
  hasDocuments,
  onSelectCitation,
  onPlayTTS,
  playingMessageId,
  loadingTtsMessageId,
  onStopTTS,
}) => {
  const [inputText, setInputText] = useState("");
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Grow the composer with its content. While empty it keeps no inline
  // height, so the stylesheet owns the resting size even if this runs before
  // CSS is applied.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!inputText) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [inputText]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText.trim());
    setInputText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const toggleSources = (msgId: string) => {
    setExpandedSources((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      // Clipboard access is blocked outside secure contexts and in some iframes.
      console.error("Copy failed:", err);
    }
  };

  const showStarters = hasDocuments && messages.length <= 2 && !isLoading;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-canvas">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 space-y-5">
          {messages.length === 0 ? (
            <div className="py-20 text-center">
              <h2 className="text-[19px] font-semibold text-ink tracking-[-0.014em]">
                Ask anything about your documents
              </h2>
              <p className="text-[13.5px] text-ink-2 mt-2 leading-relaxed max-w-sm mx-auto">
                Upload a PDF to get answers grounded in its contents, with the exact page
                cited — or start a live voice conversation.
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isUser = msg.role === "user";
              const isPlaying = playingMessageId === msg.id;
              const isTtsLoading = loadingTtsMessageId === msg.id;
              const hasSources = !!msg.sources && msg.sources.length > 0;

              if (isUser) {
                return (
                  <div
                    key={msg.id}
                    id={`chat-message-${msg.id}`}
                    className="flex justify-end rise-in"
                  >
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent text-accent-ink px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              return (
                <div key={msg.id} id={`chat-message-${msg.id}`} className="rise-in">
                  <div className="text-[14.5px] text-ink leading-[1.7]">
                    <Markdown text={msg.content} />
                  </div>

                  {/* Action row */}
                  <div className="mt-2.5 flex items-center gap-1 -ml-1.5 flex-wrap">
                    {onPlayTTS && (
                      <button
                        onClick={() =>
                          isPlaying || isTtsLoading
                            ? onStopTTS?.()
                            : onPlayTTS(msg.content, msg.id)
                        }
                        title={
                          isTtsLoading
                            ? "Cancel audio generation"
                            : isPlaying
                              ? "Stop audio"
                              : "Listen to answer"
                        }
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] font-medium transition-colors ${
                          isPlaying || isTtsLoading
                            ? "text-critical hover:bg-critical-bg"
                            : "text-ink-3 hover:text-ink hover:bg-sunken"
                        }`}
                      >
                        {isTtsLoading ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Preparing
                          </>
                        ) : isPlaying ? (
                          <>
                            <VolumeX className="w-3.5 h-3.5" />
                            Stop
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5" />
                            Listen
                          </>
                        )}
                      </button>
                    )}

                    <button
                      onClick={() => handleCopy(msg.content, msg.id)}
                      title="Copy response"
                      aria-label="Copy response"
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] font-medium text-ink-3 hover:text-ink hover:bg-sunken transition-colors"
                    >
                      {copiedId === msg.id ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-positive" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy
                        </>
                      )}
                    </button>

                    {hasSources && (
                      <button
                        onClick={() => toggleSources(msg.id)}
                        aria-expanded={!!expandedSources[msg.id]}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] font-medium text-ink-3 hover:text-ink hover:bg-sunken transition-colors"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        {msg.sources!.length} source{msg.sources!.length === 1 ? "" : "s"}
                        <ChevronDown
                          className={`w-3 h-3 transition-transform ${
                            expandedSources[msg.id] ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    )}
                  </div>

                  {/* Citations */}
                  {hasSources && expandedSources[msg.id] && (
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      {msg.sources!.map((src, sIdx) => (
                        <button
                          key={sIdx}
                          type="button"
                          onClick={() => onSelectCitation?.(src)}
                          className="text-left rounded-xl border border-line bg-surface px-3 py-2.5 hover:border-line-strong transition-colors"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <FileText className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                            <span className="text-[11.5px] font-medium text-ink truncate">
                              {src.filename}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-3 tabular-nums">
                            <span>Page {src.pageNumber}</span>
                            {typeof src.score === "number" && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{Math.round(src.score * 100)}% match</span>
                              </>
                            )}
                          </div>
                          {src.snippet && (
                            <p className="mt-1.5 text-[11px] text-ink-2 leading-relaxed line-clamp-2">
                              {src.snippet}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {isLoading && (
            <div className="flex items-center gap-2 text-[13px] text-ink-3">
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="w-1.5 h-1.5 rounded-full bg-ink-3 dot-flash" />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-ink-3 dot-flash"
                  style={{ animationDelay: "0.15s" }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-ink-3 dot-flash"
                  style={{ animationDelay: "0.3s" }}
                />
              </span>
              Searching your documents
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-line bg-canvas">
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-3.5">
          {showStarters && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {STARTER_PROMPTS.map((q, idx) => (
                <button
                  key={idx}
                  type="button"
                  disabled={isLoading}
                  onClick={() => !isLoading && onSendMessage(q)}
                  className="inline-flex items-center gap-1.5 text-[12px] text-ink-2 bg-surface hover:text-ink hover:border-line-strong border border-line rounded-full px-3 py-1.5 transition-colors disabled:opacity-50"
                >
                  <Sparkles className="w-3 h-3 text-ink-3" />
                  {q}
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="rounded-2xl border border-line bg-surface focus-within:border-line-strong transition-colors shadow-soft"
          >
            <textarea
              ref={inputRef}
              id="input-chat-message"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                hasDocuments
                  ? "Ask a question about your documents..."
                  : "Upload a PDF to get started..."
              }
              rows={1}
              disabled={isLoading}
              className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] text-ink placeholder:text-ink-3 focus:outline-none min-h-[44px] max-h-[168px] disabled:opacity-60"
            />

            <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
              <button
                id="btn-trigger-voice-modal"
                type="button"
                onClick={onOpenVoice}
                title="Start a live voice conversation"
                className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] font-medium text-ink-3 hover:text-ink hover:bg-sunken transition-colors"
              >
                <Mic className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Voice</span>
              </button>

              <button
                id="btn-send-message"
                type="submit"
                disabled={!inputText.trim() || isLoading}
                aria-label="Send message"
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-30 disabled:hover:bg-accent transition-colors"
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4" strokeWidth={2.4} />
                )}
              </button>
            </div>
          </form>

          <p className="mt-2 text-[11px] text-ink-3 text-center">
            Answers are grounded in your uploaded PDFs with page-level citations.
          </p>
        </div>
      </div>
    </div>
  );
};
