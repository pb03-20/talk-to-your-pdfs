import React, { useState, useRef } from "react";
import {
  UploadCloud,
  FileText,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  X,
  Layers,
} from "lucide-react";
import { DocumentMetadata } from "../types";

interface SidebarProps {
  documents: DocumentMetadata[];
  totalChunks: number;
  isUploading: boolean;
  uploadError?: string | null;
  onDismissUploadError?: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onDeleteDocument: (docId: string) => void;
  onResetWorkspace: () => void;
  isOpen: boolean;
  onClose: () => void;
}

function formatFileSize(bytes: number) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  documents,
  totalChunks,
  isUploading,
  uploadError,
  onDismissUploadError,
  onUploadFiles,
  onDeleteDocument,
  onResetWorkspace,
  isOpen,
  onClose,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUploadFiles(e.target.files);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const totalPages = documents.reduce((acc, d) => acc + (d.totalPages || 0), 0);

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-30 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        id="sidebar-documents"
        className={`fixed md:static inset-y-0 left-0 w-[300px] shrink-0 bg-canvas border-r border-line flex flex-col z-40 transition-transform duration-300 ease-out md:translate-x-0 ${
          isOpen ? "translate-x-0 shadow-overlay" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="h-14 shrink-0 px-4 flex items-center justify-between border-b border-line">
          <h2 className="text-[13px] font-semibold text-ink tracking-[-0.006em]">Documents</h2>
          <div className="flex items-center gap-2">
            {documents.length > 0 && (
              <span className="text-[11px] font-medium text-ink-3 tabular-nums">
                {documents.length}
              </span>
            )}
            <button
              id="btn-close-sidebar"
              onClick={onClose}
              aria-label="Close sidebar"
              className="md:hidden p-1.5 -mr-1.5 text-ink-3 hover:text-ink hover:bg-sunken rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Upload zone */}
        <div className="p-3 shrink-0">
          <div
            id="dropzone-pdf"
            role="button"
            tabIndex={0}
            aria-label="Upload PDF files"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !isUploading && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !isUploading) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
              isUploading
                ? "border-line bg-sunken cursor-default"
                : isDragOver
                  ? "border-ink bg-sunken cursor-pointer"
                  : "border-line-strong hover:border-ink-3 hover:bg-sunken/60 cursor-pointer"
            }`}
          >
            <input
              ref={fileInputRef}
              id="input-file-pdf"
              type="file"
              multiple
              accept="application/pdf"
              className="hidden"
              onChange={handleFileInputChange}
            />

            {isUploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="w-5 h-5 text-ink-2 animate-spin" />
                <p className="text-[12.5px] font-medium text-ink">Indexing documents</p>
                <p className="text-[11.5px] text-ink-3">Extracting text and building embeddings</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="w-9 h-9 rounded-full bg-sunken flex items-center justify-center text-ink-2">
                  <UploadCloud className="w-[18px] h-[18px]" />
                </div>
                <p className="text-[12.5px] font-medium text-ink">Drop PDFs or click to browse</p>
                <p className="text-[11.5px] text-ink-3">Multiple files, up to 100 MB each</p>
              </div>
            )}
          </div>

          {uploadError && (
            <div
              id="upload-error-banner"
              role="alert"
              className="mt-2.5 rounded-xl bg-critical-bg px-3 py-2.5 flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-critical mt-px shrink-0" />
              <p className="flex-1 text-[11.5px] text-critical leading-relaxed break-words">
                {uploadError}
              </p>
              {onDismissUploadError && (
                <button
                  type="button"
                  id="btn-dismiss-upload-error"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissUploadError();
                  }}
                  aria-label="Dismiss error"
                  className="text-critical/60 hover:text-critical p-0.5 rounded shrink-0 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Index summary */}
        {documents.length > 0 && (
          <div className="px-4 pb-2.5 shrink-0 flex items-center gap-3 text-[11px] text-ink-3">
            <span className="tabular-nums">
              {totalPages} page{totalPages === 1 ? "" : "s"}
            </span>
            <span className="w-px h-3 bg-line" aria-hidden="true" />
            <span className="flex items-center gap-1 tabular-nums">
              <Layers className="w-3 h-3" />
              {totalChunks} chunk{totalChunks === 1 ? "" : "s"} indexed
            </span>
          </div>
        )}

        {/* Document list */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5 min-h-0">
          {documents.length === 0 ? (
            <div className="py-10 px-4 text-center">
              <p className="text-[12.5px] font-medium text-ink-2">No documents yet</p>
              <p className="text-[11.5px] text-ink-3 mt-1 leading-relaxed">
                Upload a PDF to start asking questions with page-level citations.
              </p>
            </div>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.id}
                id={`doc-card-${doc.id}`}
                className="group rounded-xl border border-line bg-surface px-3 py-2.5 hover:border-line-strong transition-colors"
              >
                <div className="flex items-start gap-2.5">
                  <FileText className="w-4 h-4 text-ink-3 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-[12.5px] font-medium text-ink truncate leading-snug"
                      title={doc.filename}
                    >
                      {doc.filename}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-3 tabular-nums">
                      <span>{formatFileSize(doc.fileSize)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{doc.totalPages || 1} pg</span>
                      <span aria-hidden="true">·</span>
                      <span>{doc.totalChunks || 0} chunks</span>
                    </div>

                    <div className="mt-1.5">
                      {doc.status === "ready" && (
                        <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-positive">
                          <CheckCircle2 className="w-3 h-3" />
                          Ready
                        </span>
                      )}
                      {doc.status === "processing" && (
                        <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-caution">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Processing
                        </span>
                      )}
                      {doc.status === "error" && (
                        <span
                          className="inline-flex items-center gap-1 text-[10.5px] font-medium text-critical"
                          title={doc.errorMessage || "Processing error"}
                        >
                          <AlertCircle className="w-3 h-3" />
                          Failed to parse
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    id={`btn-delete-doc-${doc.id}`}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onDeleteDocument(doc.id);
                    }}
                    title="Remove from workspace"
                    aria-label={`Remove ${doc.filename}`}
                    className="p-1.5 -mr-1 -mt-0.5 rounded-lg text-ink-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-critical hover:bg-critical-bg transition-all shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-3 shrink-0 border-t border-line">
          <button
            id="btn-reset-workspace"
            onClick={onResetWorkspace}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[12px] font-medium text-ink-3 hover:text-ink hover:bg-sunken transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reset workspace
          </button>
        </div>
      </aside>
    </>
  );
};
