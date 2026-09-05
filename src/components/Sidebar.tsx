import React, { useState, useRef } from "react";
import {
  UploadCloud,
  FileText,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  RefreshCw,
  FolderOpen,
  Layers,
  X,
  FileCheck,
} from "lucide-react";
import { DocumentMetadata } from "../types";

interface SidebarProps {
  documents: DocumentMetadata[];
  totalChunks: number;
  isUploading: boolean;
  uploadError?: string | null;
  onDismissUploadError?: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onLoadSampleDoc: () => void;
  onDeleteDocument: (docId: string) => void;
  onResetWorkspace: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  documents,
  totalChunks,
  isUploading,
  uploadError,
  onDismissUploadError,
  onUploadFiles,
  onLoadSampleDoc,
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

  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const totalPages = documents.reduce((acc, d) => acc + (d.totalPages || 0), 0);

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-xs z-30 md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        id="sidebar-documents"
        className={`fixed md:static inset-y-0 left-0 w-80 bg-zinc-50 border-r border-zinc-200 flex flex-col z-40 transition-transform duration-300 ease-in-out md:translate-x-0 ${isOpen ? "translate-x-0 shadow-xl" : "-translate-x-full"
          }`}
      >
        {/* Sidebar Header */}
        <div className="p-4 border-b border-zinc-200 flex items-center justify-between bg-white">
          <div className="flex items-center space-x-2">
            <FolderOpen className="w-5 h-5 text-zinc-700" />
            <h2 className="text-sm font-semibold text-zinc-900">Documents & RAG Index</h2>
          </div>
          <button
            id="btn-close-sidebar"
            onClick={onClose}
            className="md:hidden p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Upload Zone */}
        <div className="p-4 border-b border-zinc-200 bg-white">
          <div
            id="dropzone-pdf"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all ${isDragOver
              ? "border-zinc-900 bg-zinc-100"
              : "border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50/70 bg-zinc-50/40"
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
              <div className="flex flex-col items-center py-2 space-y-2">
                <Loader2 className="w-7 h-7 text-zinc-800 animate-spin" />
                <p className="text-xs font-medium text-zinc-800">
                  Parsing & Indexing Embeddings...
                </p>
                <p className="text-[11px] text-zinc-500">Chunking pages with Gemini</p>
              </div>
            ) : (
              <div className="flex flex-col items-center space-y-2">
                <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-600">
                  <UploadCloud className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-medium text-zinc-800">
                    Click to browse or drop PDFs
                  </p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    Supports multiple PDFs (up to 100MB each)
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Upload Error Banner */}
          {uploadError && (
            <div
              id="upload-error-banner"
              className="mt-3 p-3 bg-red-50 border border-red-200 rounded-xl flex items-start justify-between text-left"
            >
              <div className="flex items-start space-x-2 mr-2">
                <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                <p className="text-xs text-red-700 leading-relaxed break-words">{uploadError}</p>
              </div>
              {onDismissUploadError && (
                <button
                  type="button"
                  id="btn-dismiss-upload-error"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissUploadError();
                  }}
                  className="text-red-400 hover:text-red-700 p-0.5 rounded shrink-0 transition-colors"
                  title="Dismiss error"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}

          {/* Instant Sample Document Button */}
          <button
            id="btn-load-sample-doc"
            onClick={onLoadSampleDoc}
            disabled={isUploading}
            className="w-full mt-3 flex items-center justify-center space-x-2 py-2 px-3 text-xs font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200/80 rounded-lg transition-colors border border-zinc-200"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-600" />
            <span>Load Architecture Whitepaper Sample</span>
          </button>
        </div>

        {/* Workspace Summary Stats */}
        <div className="px-4 py-2.5 bg-zinc-100/70 border-b border-zinc-200 flex items-center justify-between text-xs text-zinc-600">
          <div className="flex items-center space-x-1.5">
            <FileCheck className="w-3.5 h-3.5 text-zinc-500" />
            <span>
              {documents.length} Docs ({totalPages} pgs)
            </span>
          </div>
          <div className="flex items-center space-x-1.5">
            <Layers className="w-3.5 h-3.5 text-zinc-500" />
            <span>{totalChunks} Chunks</span>
          </div>
        </div>

        {/* Document List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {documents.length === 0 ? (
            <div className="py-10 text-center px-4">
              <FileText className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
              <p className="text-xs font-medium text-zinc-600">No PDFs uploaded yet</p>
              <p className="text-[11px] text-zinc-400 mt-1 max-w-[200px] mx-auto">
                Drop your PDF files or load the sample paper above to start searching.
              </p>
            </div>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.id}
                id={`doc-card-${doc.id}`}
                className="bg-white border border-zinc-200 rounded-xl p-3 shadow-2xs hover:border-zinc-300 transition-colors group"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-2.5 min-w-0 flex-1">
                    <div className="p-1.5 rounded-lg bg-zinc-100 text-zinc-700 shrink-0 mt-0.5">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-xs font-semibold text-zinc-800 truncate"
                        title={doc.filename}
                      >
                        {doc.filename}
                      </p>
                      <div className="flex items-center space-x-2 mt-1 text-[11px] text-zinc-500">
                        <span>{formatFileSize(doc.fileSize)}</span>
                        <span>•</span>
                        <span>{doc.totalPages || 1} pgs</span>
                        <span>•</span>
                        <span>{doc.totalChunks || 0} chunks</span>
                      </div>
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
                    title="Remove PDF from workspace"
                    aria-label={`Remove ${doc.filename}`}
                    className="p-1.5 text-zinc-400 hover:text-rose-600 hover:bg-rose-50 active:bg-rose-100 rounded-lg transition-colors ml-1 shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Status Indicator */}
                <div className="mt-2.5 flex items-center justify-between pt-2 border-t border-zinc-100">
                  {doc.status === "ready" && (
                    <span className="inline-flex items-center text-[10px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Indexed & Ready
                    </span>
                  )}
                  {doc.status === "processing" && (
                    <span className="inline-flex items-center text-[10px] font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      Extracting text...
                    </span>
                  )}
                  {doc.status === "error" && (
                    <span
                      className="inline-flex items-center text-[10px] font-medium text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full truncate"
                      title={doc.errorMessage || "Processing error"}
                    >
                      <AlertCircle className="w-3 h-3 mr-1 shrink-0" />
                      Failed to parse
                    </span>
                  )}

                  <span className="text-[10px] text-zinc-400">
                    {new Date(doc.uploadedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Sidebar Footer */}
        <div className="p-3 border-t border-zinc-200 bg-white">
          <button
            id="btn-reset-workspace"
            onClick={onResetWorkspace}
            className="w-full flex items-center justify-center space-x-2 py-2 px-3 text-xs font-medium text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors border border-transparent hover:border-zinc-200"
          >
            <RefreshCw className="w-3.5 h-3.5 text-zinc-500" />
            <span>Reset Isolated Workspace</span>
          </button>
          <p className="text-[10px] text-zinc-400 text-center mt-1.5">
            Anonymous visitor temporary session
          </p>
        </div>
      </aside>
    </>
  );
};
