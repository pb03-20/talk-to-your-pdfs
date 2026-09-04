import React from "react";
import { X, FileText, BookOpen, Check } from "lucide-react";
import { SourceCitation } from "../types";

interface CitationModalProps {
  citation: SourceCitation | null;
  onClose: () => void;
}

export const CitationModal: React.FC<CitationModalProps> = ({ citation, onClose }) => {
  if (!citation) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        id="modal-citation-viewer"
        className="bg-white border border-zinc-200 rounded-2xl w-full max-w-lg shadow-xl overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-zinc-200 flex items-center justify-between bg-zinc-50/70">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-lg bg-zinc-100 text-zinc-700">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-900 truncate max-w-xs">
                {citation.filename}
              </h3>
              <div className="flex items-center space-x-2 text-[11px] text-zinc-500">
                <span className="font-mono bg-zinc-200/70 px-1.5 py-0.2 rounded text-zinc-700">
                  Page {citation.pageNumber}
                </span>
                {typeof citation.score === "number" && (
                  <>
                    <span>•</span>
                    <span className="text-emerald-700 font-medium">
                      {Math.round(citation.score * 100)}% relevance match
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <button
            id="btn-close-citation-modal"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 max-h-[60vh] overflow-y-auto bg-zinc-50/30">
          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
            <BookOpen className="w-3.5 h-3.5" />
            <span>Extracted Passage & Context</span>
          </div>

          <div className="bg-white border border-zinc-200 rounded-xl p-4 text-xs sm:text-sm text-zinc-800 leading-relaxed font-mono whitespace-pre-wrap shadow-2xs">
            {citation.snippet}
          </div>
        </div>

        <div className="p-3.5 bg-white border-t border-zinc-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium rounded-xl transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
