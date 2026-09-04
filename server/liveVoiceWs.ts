import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { getGeminiClient } from "./geminiClient.js";
import { Modality, LiveServerMessage } from "@google/genai";
import { workspaceStore } from "./workspaceStore.js";

export function setupLiveVoiceWebSocket(wss: WebSocketServer) {
  wss.on("connection", async (clientWs: WebSocket, req: IncomingMessage) => {
    const urlObj = new URL(req.url || "/", "http://localhost:3000");
    const workspaceId = urlObj.searchParams.get("workspaceId") || "default";

    // Gather context from workspace documents
    const docs = workspaceStore.getDocuments(workspaceId);
    const chunks = workspaceStore.getChunks(workspaceId);

    let docContextSummary = "";
    if (docs.length > 0) {
      docContextSummary = `Uploaded Documents in this workspace:\n` +
        docs.map((d) => `- ${d.filename} (${d.totalPages} pages)`).join("\n") +
        `\n\nKey excerpts from documents:\n` +
        chunks.slice(0, 15).map((c) => `[${c.filename}, Page ${c.pageNumber}]: ${c.text.slice(0, 300)}`).join("\n\n");
    } else {
      docContextSummary = "No documents have been uploaded to this workspace yet. Inform the user to upload PDFs.";
    }

    const systemInstruction = `You are the real-time voice assistant for "Talk to Your PDFs".
You are conversing with the user via live voice. Keep answers spoken, clear, conversational, and direct.

DOCUMENT CONTEXT:
${docContextSummary}

RULES:
1. Ground your answers in the user's uploaded PDFs when applicable.
2. If asked about facts found in the documents, mention the document name and page number.
3. If the requested information is not in the PDFs, explicitly tell the user: "I couldn't find that in your uploaded PDFs." Do NOT make up facts.
4. Keep spoken responses concise and easy to listen to (avoid huge lists; give summaries with key page references).`;

    let liveSession: any = null;

    try {
      const ai = getGeminiClient();
      clientWs.send(JSON.stringify({ type: "status", status: "connecting", message: "Connecting to Gemini Live API..." }));

      liveSession = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Zephyr" },
            },
          },
          systemInstruction,
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            try {
              // Check for model output audio
              const parts = message.serverContent?.modelTurn?.parts;
              if (parts && parts.length > 0) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    clientWs.send(JSON.stringify({
                      type: "audio",
                      audio: part.inlineData.data,
                    }));
                  }
                  if (part.text) {
                    clientWs.send(JSON.stringify({
                      type: "outputTranscript",
                      text: part.text,
                    }));
                  }
                }
              }

              // Check for interruption
              if (message.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ type: "interrupted" }));
              }
            } catch (err) {
              console.error("Error processing Live API message:", err);
            }
          },
          onclose: () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: "status", status: "disconnected", message: "Live session ended." }));
            }
          },
          onerror: (err: any) => {
            console.error("Live API session error:", err);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: "error", message: err?.message || "Live API error" }));
            }
          },
        },
      });

      clientWs.send(JSON.stringify({ type: "status", status: "ready", message: "Gemini Live connected and ready for speech." }));

      // Handle messages from client
      clientWs.on("message", (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === "audio" && data.audio) {
            // Send 16kHz PCM audio chunk
            liveSession.sendRealtimeInput({
              audio: {
                data: data.audio,
                mimeType: "audio/pcm;rate=16000",
              },
            });
          } else if (data.type === "text" && data.text) {
            liveSession.sendRealtimeInput({
              text: data.text,
            });
          }
        } catch (e) {
          console.error("Error sending input to Live API session:", e);
        }
      });

      clientWs.on("close", () => {
        try {
          if (liveSession && typeof liveSession.close === "function") {
            liveSession.close();
          }
        } catch (e) {
          // ignore cleanup errors
        }
      });
    } catch (err: any) {
      console.error("Failed to initialize Gemini Live session:", err);
      clientWs.send(JSON.stringify({
        type: "error",
        message: `Could not start Gemini Live session: ${err?.message || "Check API configuration"}`,
      }));
    }
  });
}
