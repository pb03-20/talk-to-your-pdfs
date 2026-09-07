import React, { useEffect } from "react";
import { X, FileText } from "lucide-react";
import { SourceCitation } from "../types";

interface CitationModalProps {
  citation: SourceCitation | null;
  onClose: () => void;
}

export const CitationModal: React.FC<CitationModalProps> = ({ citation, onClose }) => {
  // Escape should close the inspector, as with any dialog.
  useEffect(() => {
    if (!citation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [citation, onClose]);

  if (!citation) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Cited passage"
    >
      <div
        id="modal-citation-viewer"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl bg-surface shadow-overlay overflow-hidden rise-in"
      >
        <div className="px-4 py-3.5 border-b border-line flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="w-4 h-4 text-ink-3 shrink-0" />
              <h3 className="text-[13px] font-semibold text-ink truncate">
                {citation.filename}
              </h3>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-3 tabular-nums pl-6">
              <span>Page {citation.pageNumber}</span>
              {typeof citation.score === "number" && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{Math.round(citation.score * 100)}% relevance</span>
                </>
              )}
            </div>
          </div>

          <button
            id="btn-close-citation-modal"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 -mr-1 -mt-0.5 text-ink-3 hover:text-ink hover:bg-sunken rounded-lg transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 max-h-[60vh] overflow-y-auto">
          <p className="text-[10.5px] font-medium text-ink-3 uppercase tracking-[0.06em] mb-2">
            Extracted passage
          </p>
          <div className="rounded-xl bg-sunken px-3.5 py-3 text-[13px] text-ink leading-[1.7] whitespace-pre-wrap break-words">
            {citation.snippet}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-line flex justify-end">
          <button
            onClick={onClose}
            className="px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-ink text-[12.5px] font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
