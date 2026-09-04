import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  Mic,
  Bot,
  User,
  BookOpen,
  Volume2,
  VolumeX,
  Sparkles,
  ChevronDown,
  ChevronUp,
  FileText,
  Copy,
  Check,
  RotateCcw,
} from "lucide-react";
import { ChatMessage, SourceCitation } from "../types";

interface ChatAreaProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  onOpenVoice: () => void;
  hasDocuments: boolean;
  onSelectCitation?: (citation: SourceCitation) => void;
  onPlayTTS?: (text: string) => void;
  playingMessageId?: string | null;
  onStopTTS?: () => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  onSendMessage,
  isLoading,
  onOpenVoice,
  hasDocuments,
  onSelectCitation,
  onPlayTTS,
  playingMessageId,
  onStopTTS,
}) => {
  const [inputText, setInputText] = useState("");
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

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
    setExpandedSources((prev) => ({
      ...prev,
      [msgId]: !prev[msgId],
    }));
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const sampleQuestions = [
    "What are the benchmark chunking parameters in the document?",
    "Explain the cosine similarity metric and hybrid search approach.",
    "What are the input audio specifications for Gemini Live voice?",
    "How does multi-tenant workspace isolation work for anonymous visitors?",
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-50/50 overflow-hidden">
      {/* Messages Feed */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 space-y-6">
        {messages.length === 0 ? (
          <div className="max-w-xl mx-auto my-auto text-center py-16">
            <div className="w-12 h-12 rounded-2xl bg-zinc-900 text-white flex items-center justify-center mx-auto mb-4 shadow-sm">
              <Bot className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-semibold text-zinc-900">Talk to Your PDFs</h2>
            <p className="text-sm text-zinc-500 mt-2 leading-relaxed">
              Upload documents in the sidebar to ask questions with grounded citations, or tap the microphone to have a live spoken conversation.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === "user";
            const isPlaying = playingMessageId === msg.id;

            return (
              <div
                key={msg.id}
                id={`chat-message-${msg.id}`}
                className={`flex items-start space-x-3 max-w-3xl ${
                  isUser ? "ml-auto flex-row-reverse space-x-reverse" : "mr-auto"
                }`}
              >
                {/* Avatar */}
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 shadow-2xs ${
                    isUser
                      ? "bg-zinc-900 text-white"
                      : "bg-white border border-zinc-200 text-zinc-800"
                  }`}
                >
                  {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                </div>

                {/* Message Box */}
                <div className={`flex-1 min-w-0 ${isUser ? "text-right" : "text-left"}`}>
                  <div
                    className={`inline-block text-sm rounded-2xl px-4 py-3 shadow-2xs leading-relaxed max-w-full ${
                      isUser
                        ? "bg-zinc-900 text-white rounded-tr-xs"
                        : "bg-white text-zinc-800 border border-zinc-200/80 rounded-tl-xs"
                    }`}
                  >
                    {/* Message content */}
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>

                    {/* AI Message Action bar */}
                    {!isUser && (
                      <div className="mt-3 pt-2.5 border-t border-zinc-100 flex items-center justify-between text-xs text-zinc-400">
                        <div className="flex items-center space-x-2">
                          {onPlayTTS && (
                            <button
                              onClick={() => (isPlaying ? onStopTTS?.() : onPlayTTS(msg.content))}
                              className={`flex items-center space-x-1 px-2 py-1 rounded-md text-xs transition-colors ${
                                isPlaying
                                  ? "bg-rose-50 text-rose-600 font-medium"
                                  : "hover:bg-zinc-100 text-zinc-600"
                              }`}
                              title={isPlaying ? "Stop audio" : "Listen to answer"}
                            >
                              {isPlaying ? (
                                <>
                                  <VolumeX className="w-3.5 h-3.5 mr-1" />
                                  <span>Stop</span>
                                </>
                              ) : (
                                <>
                                  <Volume2 className="w-3.5 h-3.5 mr-1" />
                                  <span>Read Aloud</span>
                                </>
                              )}
                            </button>
                          )}

                          <button
                            onClick={() => handleCopy(msg.content, msg.id)}
                            className="p-1 hover:bg-zinc-100 rounded text-zinc-500 transition-colors"
                            title="Copy response"
                          >
                            {copiedId === msg.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        {msg.sources && msg.sources.length > 0 && (
                          <button
                            onClick={() => toggleSources(msg.id)}
                            className="flex items-center space-x-1 text-xs text-zinc-600 hover:text-zinc-900 font-medium cursor-pointer"
                          >
                            <BookOpen className="w-3.5 h-3.5 text-zinc-500" />
                            <span>{msg.sources.length} Sources cited</span>
                            {expandedSources[msg.id] ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Expandable Citations / Sources */}
                  {!isUser && msg.sources && msg.sources.length > 0 && expandedSources[msg.id] && (
                    <div className="mt-2.5 space-y-1.5 pl-1">
                      {msg.sources.map((src, sIdx) => (
                        <div
                          key={sIdx}
                          onClick={() => onSelectCitation?.(src)}
                          className="bg-white border border-zinc-200/90 rounded-xl p-2.5 text-xs text-left shadow-2xs hover:border-zinc-300 hover:bg-zinc-50/50 transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center justify-between font-medium text-zinc-800">
                            <div className="flex items-center space-x-1.5 truncate">
                              <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                              <span className="truncate">{src.filename}</span>
                            </div>
                            <div className="flex items-center space-x-2 shrink-0 ml-2">
                              <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700 font-mono text-[10px]">
                                Page {src.pageNumber}
                              </span>
                              {typeof src.score === "number" && (
                                <span className="text-[10px] text-emerald-600 font-medium">
                                  {Math.round(src.score * 100)}% match
                                </span>
                              )}
                            </div>
                          </div>
                          {src.snippet && (
                            <p className="mt-1.5 text-zinc-500 text-[11px] line-clamp-2 leading-relaxed italic bg-zinc-50/80 p-1.5 rounded-lg border border-zinc-100">
                              "{src.snippet}"
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="text-[10px] text-zinc-400 mt-1 px-1">
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Thinking / Retrieval indicator */}
        {isLoading && (
          <div className="flex items-start space-x-3 max-w-xl mr-auto">
            <div className="w-8 h-8 rounded-xl bg-white border border-zinc-200 flex items-center justify-center shrink-0 text-zinc-700 shadow-2xs">
              <Bot className="w-4 h-4 animate-spin" />
            </div>
            <div className="bg-white border border-zinc-200 rounded-2xl rounded-tl-xs px-4 py-3 shadow-2xs">
              <div className="flex items-center space-x-2 text-xs text-zinc-600">
                <Sparkles className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                <span>Searching vector embeddings & generating answer...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Suggested Questions */}
      {hasDocuments && messages.length <= 2 && !isLoading && (
        <div className="px-4 sm:px-6 py-2">
          <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">
            Suggested questions for uploaded PDFs
          </p>
          <div className="flex flex-wrap gap-1.5">
            {sampleQuestions.map((q, idx) => (
              <button
                key={idx}
                onClick={() => onSendMessage(q)}
                className="text-xs text-zinc-700 bg-white hover:bg-zinc-100 hover:text-zinc-900 border border-zinc-200 rounded-lg px-2.5 py-1.5 transition-colors text-left shadow-2xs"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="p-4 sm:p-5 bg-white border-t border-zinc-200">
        <form onSubmit={handleSubmit} className="relative max-w-4xl mx-auto flex items-end gap-2">
          <div className="flex-1 relative bg-zinc-100/80 hover:bg-zinc-100 focus-within:bg-white border border-zinc-200 focus-within:border-zinc-400 rounded-2xl transition-all shadow-2xs">
            <textarea
              ref={inputRef}
              id="input-chat-message"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                hasDocuments
                  ? "Ask anything about your PDFs... (Press Enter to send)"
                  : "Upload a PDF first, then ask questions here..."
              }
              rows={1}
              className="w-full px-4 py-3 text-sm text-zinc-900 placeholder-zinc-400 bg-transparent focus:outline-none resize-none max-h-36 min-h-[46px]"
              disabled={isLoading}
            />
          </div>

          <div className="flex items-center space-x-1.5 shrink-0">
            {/* Live Voice Trigger */}
            <button
              id="btn-trigger-voice-modal"
              type="button"
              onClick={onOpenVoice}
              title="Open Voice Conversation"
              className="p-3 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-700 transition-colors"
            >
              <Mic className="w-4 h-4" />
            </button>

            {/* Send Button */}
            <button
              id="btn-send-message"
              type="submit"
              disabled={!inputText.trim() || isLoading}
              className="p-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900 text-white transition-colors shadow-xs"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </form>

        <p className="text-[11px] text-zinc-400 text-center mt-2">
          Answers are grounded directly on your uploaded PDFs with exact page references.
        </p>
      </div>
    </div>
  );
};
