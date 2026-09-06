import express from "express";
import http from "http";
import path from "path";
import multer from "multer";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import { workspaceStore } from "./server/workspaceStore.js";
import { extractPdfText, chunkDocumentPages } from "./server/pdfParser.js";
import { embedChunks, askGeminiRag } from "./server/ragService.js";
import { setupLiveVoiceWebSocket } from "./server/liveVoiceWs.js";
import { SAMPLE_DOCUMENT } from "./server/sampleDoc.js";
import { getGeminiClient } from "./server/geminiClient.js";
import { Modality } from "@google/genai";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max per file
    files: 30, // Up to 30 files
  },
});

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  // Helper to extract workspace ID from request
  const getWorkspaceId = (req: express.Request): string => {
    const wsHeader = req.headers["x-workspace-id"];
    if (typeof wsHeader === "string" && wsHeader.trim()) {
      return wsHeader.trim();
    }
    if (typeof req.query.workspaceId === "string" && req.query.workspaceId.trim()) {
      return req.query.workspaceId.trim();
    }
    if (req.body && typeof req.body.workspaceId === "string" && req.body.workspaceId.trim()) {
      return req.body.workspaceId.trim();
    }
    return "default_workspace";
  };

  // --- API ROUTES FIRST ---

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Get current workspace status, documents, and messages
  app.get("/api/workspace", (req, res) => {
    const wsId = getWorkspaceId(req);
    const ws = workspaceStore.getOrCreateWorkspace(wsId);
    res.json({
      workspaceId: ws.id,
      documents: ws.documents,
      totalChunks: ws.chunks.length,
      messages: ws.messages,
    });
  });

  // Reset/Clear workspace
  app.post("/api/workspace/reset", (req, res) => {
    const wsId = getWorkspaceId(req);
    workspaceStore.clearWorkspace(wsId);
    const newWs = workspaceStore.getOrCreateWorkspace(wsId);
    res.json({
      success: true,
      message: "Workspace cleared successfully.",
      workspace: newWs,
    });
  });

  // Clear messages only
  app.post("/api/workspace/clear-chat", (req, res) => {
    const wsId = getWorkspaceId(req);
    workspaceStore.clearMessages(wsId);
    res.json({ success: true, message: "Chat history cleared." });
  });

  // Multi-PDF upload endpoint with dedicated Multer error handling
  app.post(
    "/api/upload",
    (req, res, next) => {
      upload.array("files", 30)(req, res, (err: any) => {
        if (err) {
          console.error("Multer upload error:", err);
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              return res.status(413).json({
                error: "File is too large. Maximum supported PDF size is 100MB per file.",
              });
            }
            if (err.code === "LIMIT_FILE_COUNT") {
              return res.status(400).json({
                error: "Too many files uploaded at once. Maximum is 30 files per upload.",
              });
            }
            return res.status(400).json({
              error: `Upload error: ${err.message}`,
            });
          }
          return res.status(500).json({
            error: `Upload failed: ${err.message || "Unknown upload error"}`,
          });
        }
        next();
      });
    },
    async (req, res) => {
      const wsId = getWorkspaceId(req);
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const results = [];

      for (const file of files) {
        const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const filename = Buffer.from(file.originalname, "latin1").toString("utf8");

        // Initial document metadata
        workspaceStore.addDocument(wsId, {
          id: docId,
          workspaceId: wsId,
          filename,
          fileSize: file.size,
          totalPages: 0,
          totalChunks: 0,
          uploadedAt: new Date().toISOString(),
          status: "processing",
        });

        try {
          // 1. Extract text and pages
          const parseResult = await extractPdfText(file.buffer);

          // 2. Chunk text
          const chunks = chunkDocumentPages(
            wsId,
            docId,
            filename,
            parseResult.pages,
            700,
            100
          );

          // 3. Generate embeddings
          await embedChunks(chunks);

          // 4. Save to vector index
          workspaceStore.addChunks(wsId, chunks);

          // 5. Update status
          workspaceStore.updateDocumentStatus(
            wsId,
            docId,
            "ready",
            chunks.length,
            parseResult.totalPages
          );

          results.push({
            docId,
            filename,
            pages: parseResult.totalPages,
            chunks: chunks.length,
            status: "ready",
          });
        } catch (err: any) {
          console.error(`Error processing file ${filename}:`, err);
          workspaceStore.updateDocumentStatus(
            wsId,
            docId,
            "error",
            0,
            0,
            err?.message || "Failed to parse PDF"
          );
          results.push({
            docId,
            filename,
            status: "error",
            error: err?.message || "Parsing error",
          });
        }
      }

      const updatedWs = workspaceStore.getOrCreateWorkspace(wsId);
      res.json({
        success: true,
        processed: results,
        documents: updatedWs.documents,
        totalChunks: updatedWs.chunks.length,
      });
    });

  // Preload sample document
  app.post("/api/sample-doc", async (req, res) => {
    const wsId = getWorkspaceId(req);
    const docId = `sample_${Date.now()}`;

    workspaceStore.addDocument(wsId, {
      id: docId,
      workspaceId: wsId,
      filename: SAMPLE_DOCUMENT.filename,
      fileSize: 42000,
      totalPages: SAMPLE_DOCUMENT.totalPages,
      totalChunks: 0,
      uploadedAt: new Date().toISOString(),
      status: "processing",
    });

    try {
      const chunks = chunkDocumentPages(
        wsId,
        docId,
        SAMPLE_DOCUMENT.filename,
        SAMPLE_DOCUMENT.pages,
        700,
        100
      );

      await embedChunks(chunks);
      workspaceStore.addChunks(wsId, chunks);
      workspaceStore.updateDocumentStatus(
        wsId,
        docId,
        "ready",
        chunks.length,
        SAMPLE_DOCUMENT.totalPages
      );

      const ws = workspaceStore.getOrCreateWorkspace(wsId);
      res.json({
        success: true,
        document: ws.documents.find((d) => d.id === docId),
        totalChunks: ws.chunks.length,
      });
    } catch (err: any) {
      console.error("Error loading sample document:", err);
      res.status(500).json({ error: err?.message || "Failed to load sample document" });
    }
  });

  // Delete document
  app.delete("/api/documents/:docId", (req, res) => {
    const wsId = getWorkspaceId(req);
    const docId = req.params.docId;
    const removed = workspaceStore.removeDocument(wsId, docId);
    if (!removed) {
      return res.status(404).json({ error: "Document not found" });
    }
    const ws = workspaceStore.getOrCreateWorkspace(wsId);
    res.json({
      success: true,
      documents: ws.documents,
      totalChunks: ws.chunks.length,
    });
  });

  // Chat query endpoint (Text RAG)
  app.post("/api/chat", async (req, res) => {
    const wsId = getWorkspaceId(req);
    const { message } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const userMsgId = `user_${Date.now()}`;
    const userMsg = {
      id: userMsgId,
      role: "user" as const,
      content: message.trim(),
      timestamp: new Date().toISOString(),
    };
    workspaceStore.addMessage(wsId, userMsg);

    try {
      const history = workspaceStore.getMessages(wsId);
      const { answer, sources } = await askGeminiRag(wsId, message.trim(), history);

      const modelMsgId = `model_${Date.now()}`;
      const modelMsg = {
        id: modelMsgId,
        role: "model" as const,
        content: answer,
        sources,
        timestamp: new Date().toISOString(),
      };
      workspaceStore.addMessage(wsId, modelMsg);

      res.json({
        answer,
        sources,
        messageId: modelMsgId,
      });
    } catch (err: any) {
      console.error("Chat generation error:", err);
      res.status(500).json({
        error: err?.message || "Failed to generate answer",
      });
    }
  });

  // Text-to-Speech endpoint (Gemini TTS with smart sentence chunking)
  app.post("/api/tts", async (req, res) => {
    const { text, voice = "Kore" } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    try {
      const ai = getGeminiClient();
      let cleanText = text.replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
      const MAX_TTS_TOTAL = 4000;
      const isTruncated = cleanText.length > MAX_TTS_TOTAL;
      if (isTruncated) {
        cleanText = cleanText.slice(0, MAX_TTS_TOTAL);
      }

      // Sentence-based chunking into ≤ 800 char segments
      const sentences = cleanText.split(/(?<=[.!?])\s+/);
      const textChunks: string[] = [];
      let curr = "";
      for (const s of sentences) {
        if (curr.length + s.length + 1 <= 800) {
          curr = (curr + " " + s).trim();
        } else {
          if (curr) textChunks.push(curr);
          if (s.length > 800) {
            for (let i = 0; i < s.length; i += 800) {
              textChunks.push(s.slice(i, i + 800));
            }
            curr = "";
          } else {
            curr = s;
          }
        }
      }
      if (curr) textChunks.push(curr);

      if (textChunks.length === 0) {
        return res.status(400).json({ error: "No speakable text found" });
      }

      const audioBuffers: Buffer[] = [];
      for (const chunk of textChunks) {
        let chunkAudio: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const response = await ai.models.generateContent({
              model: "gemini-2.5-flash-preview-tts",
              contents: [{ parts: [{ text: chunk }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                  },
                },
              },
            });
            chunkAudio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (chunkAudio) break;
          } catch (genErr: any) {
            const is503 = genErr?.message?.includes("503") || genErr?.message?.includes("UNAVAILABLE");
            if (is503 && attempt === 1) {
              await new Promise((r) => setTimeout(r, 600));
              continue;
            }
            break;
          }
        }
        if (chunkAudio) {
          audioBuffers.push(Buffer.from(chunkAudio, "base64"));
        } else if (audioBuffers.length === 0) {
          return res.status(500).json({ error: "Failed to generate TTS audio" });
        } else {
          break;
        }
      }

      const combinedBuffer = Buffer.concat(audioBuffers);
      res.json({
        audio: combinedBuffer.toString("base64"),
        sampleRate: 24000,
        totalCharacters: cleanText.length,
        chunksProcessed: audioBuffers.length,
        isTruncated,
      });
    } catch (err: any) {
      console.warn("TTS generation warning:", err?.message || err);
      res.status(500).json({ error: err?.message || "TTS generation failed" });
    }
  });

  // Global error handler for uncaught API & Multer errors
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "File is too large. Maximum supported PDF size is 100MB per file.",
        });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      console.error("Unhandled API error:", err);
      return res.status(err.status || 500).json({
        error: err.message || "An unexpected error occurred processing your request.",
      });
    }
    next();
  });

  // --- WEBSOCKET SERVER FOR GEMINI LIVE VOICE ---
  const wss = new WebSocketServer({ noServer: true });
  setupLiveVoiceWebSocket(wss);

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://localhost:3000").pathname;
    if (pathname === "/api/live-voice") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // --- VITE MIDDLEWARE SETUP ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}


startServer();

