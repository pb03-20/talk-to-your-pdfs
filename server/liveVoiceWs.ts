import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { getGeminiClient } from "./geminiClient.js";
import { Modality, LiveServerMessage } from "@google/genai";
import { workspaceStore } from "./workspaceStore.js";
import { DocumentChunk } from "./types.js";

/**
 * Live-capable models, most preferred first. The previously hard-coded
 * "gemini-2.0-flash-live-preview-04-09" has been retired: connecting to it
 * never resolves and never rejects, so the browser sat on "Connecting..."
 * forever with nothing in the logs.
 */
const LIVE_MODEL_CANDIDATES = [
  "gemini-2.5-flash-native-audio-latest",
  "gemini-2.5-flash-native-audio-preview-09-2025",
  "gemini-3.1-flash-live-preview",
];

/** A hung Live handshake must fail loudly rather than hang the client. */
const CONNECT_TIMEOUT_MS = 12000;

/**
 * Rough character budget for document context handed to the voice session.
 *
 * This is deliberately modest. Everything here sits in the system instruction
 * for the life of the session, so a large budget eats the context window
 * before the conversation even starts, and audio tokens accumulate quickly on
 * top of it. Combined with the sliding-window compression configured below,
 * this keeps sessions alive across many turns.
 */
const CONTEXT_CHAR_BUDGET = 12000;

const LANGUAGE_CODES: Record<string, string> = {
  English: "en-US",
  Hindi: "hi-IN",
  Bengali: "bn-IN",
  Tamil: "ta-IN",
  Telugu: "te-IN",
  Marathi: "mr-IN",
};

/**
 * Builds document context for the voice session. The previous version took the
 * first 15 chunks truncated to 300 characters, which meant the assistant only
 * ever "knew" the opening page or two of the first PDF uploaded.
 */
function buildDocumentContext(chunks: DocumentChunk[]): string {
  if (chunks.length === 0) return "";

  // Spread the budget evenly across chunks so later pages and later documents
  // are represented too, instead of only the head of the index.
  const perChunk = Math.max(
    300,
    Math.floor(CONTEXT_CHAR_BUDGET / Math.min(chunks.length, 120))
  );
  const selected =
    chunks.length <= 120
      ? chunks
      : chunks.filter((_, i) => i % Math.ceil(chunks.length / 120) === 0);

  const sections: string[] = [];
  let used = 0;
  for (const c of selected) {
    const text = c.text.slice(0, perChunk);
    if (used + text.length > CONTEXT_CHAR_BUDGET) break;
    used += text.length;
    sections.push(`[${c.filename}, Page ${c.pageNumber}]: ${text}`);
  }
  return sections.join("\n\n");
}

export function setupLiveVoiceWebSocket(wss: WebSocketServer) {
  wss.on("connection", async (clientWs: WebSocket, req: IncomingMessage) => {
    const urlObj = new URL(req.url || "/", "http://localhost:3000");
    const workspaceId = urlObj.searchParams.get("workspaceId") || "default";
    const responseLanguage = urlObj.searchParams.get("responseLanguage") || "auto";

    const sendToClient = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    // Gather context from workspace documents
    const docs = workspaceStore.getDocuments(workspaceId);
    const chunks = workspaceStore.getChunks(workspaceId);

    let docContextSummary: string;
    if (docs.length > 0) {
      docContextSummary =
        `Uploaded Documents in this workspace:\n` +
        docs.map((d) => `- ${d.filename} (${d.totalPages} pages)`).join("\n") +
        `\n\nExcerpts from those documents:\n` +
        buildDocumentContext(chunks);
    } else {
      docContextSummary =
        "No documents have been uploaded to this workspace yet. Inform the user to upload PDFs.";
    }

    const languageRule =
      responseLanguage && responseLanguage !== "auto"
        ? `5. Always reply in ${responseLanguage}, regardless of the language the user speaks in.`
        : `5. Reply in whichever language the user speaks to you in.`;

    const systemInstruction = `You are the real-time voice assistant for "Talk to Your PDFs".
You are conversing with the user via live voice. Keep answers spoken, clear, conversational, and direct.

DOCUMENT CONTEXT:
${docContextSummary}

RULES:
1. Ground your answers in the user's uploaded PDFs when applicable.
2. If asked about facts found in the documents, mention the document name and page number.
3. If the requested information is not in the PDFs, explicitly tell the user: "I couldn't find that in your uploaded PDFs." Do NOT make up facts.
4. Keep spoken responses concise and easy to listen to (avoid huge lists; give summaries with key page references).
${languageRule}`;

    const languageCode = LANGUAGE_CODES[responseLanguage];

    let liveSession: any = null;
    let closed = false;
    let attemptCounter = 0;
    let establishedAttempt = -1;

    clientWs.on("close", () => {
      closed = true;
      try {
        if (liveSession && typeof liveSession.close === "function") {
          liveSession.close();
        }
      } catch {
        // ignore cleanup errors
      }
    });

    const handleLiveMessage = (message: LiveServerMessage) => {
      try {
        const serverContent = message.serverContent as any;

        const parts = serverContent?.modelTurn?.parts;
        if (parts && parts.length > 0) {
          for (const part of parts) {
            if (part.inlineData?.data) {
              sendToClient({ type: "audio", audio: part.inlineData.data });
            }
            // Native-audio models put their private reasoning in `part.text`
            // with `thought: true`. Forwarding it dumped raw chain-of-thought
            // into the transcript pane; the spoken words arrive separately on
            // `outputTranscription` below.
            if (part.text && !part.thought) {
              sendToClient({ type: "outputTranscript", text: part.text });
            }
          }
        }

        // Transcriptions arrive on `inputTranscription` / `outputTranscription`.
        // The old code read `inputTranscript`, a field that does not exist, so
        // the transcript pane never received anything from Gemini at all.
        if (serverContent?.inputTranscription?.text) {
          sendToClient({
            type: "inputTranscript",
            text: serverContent.inputTranscription.text,
          });
        }
        if (serverContent?.outputTranscription?.text) {
          sendToClient({
            type: "outputTranscript",
            text: serverContent.outputTranscription.text,
          });
        }

        if (serverContent?.turnComplete) {
          sendToClient({ type: "turnComplete" });
        }

        if (serverContent?.interrupted) {
          sendToClient({ type: "interrupted" });
        }
      } catch (err) {
        console.error("Error processing Live API message:", err);
      }
    };

    /** Resolves on open, rejects on timeout or on an immediate server close. */
    const connectWithTimeout = (model: string) =>
      new Promise<any>((resolve, reject) => {
        const attemptId = ++attemptCounter;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Timed out connecting to ${model}`));
          }
        }, CONNECT_TIMEOUT_MS);

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };

        getGeminiClient()
          .live.connect({
            model,
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
                ...(languageCode ? { languageCode } : {}),
              },
              // Without these two the Live Transcript pane has nothing to show.
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              // Without compression a Live session is terminated outright once
              // its context window fills. Spoken audio consumes tokens quickly,
              // so sessions were dying after a turn or two and the user had to
              // hit "Reconnect Session" to ask anything else. A sliding window
              // discards the oldest turns instead of ending the conversation.
              contextWindowCompression: { slidingWindow: {} },
              systemInstruction,
            },
            callbacks: {
              onmessage: handleLiveMessage,
              onclose: (evt: any) => {
                // A rejected model closes the socket instead of throwing.
                finish(() =>
                  reject(new Error(evt?.reason || `${model} closed the session`))
                );
                console.warn(
                  `Gemini Live session closed (code=${evt?.code ?? "?"}) reason=${evt?.reason || "(none given)"}`
                );
                // Only the session we actually settled on should tear down the
                // browser connection; a rejected model candidate must not.
                if (!closed && attemptId === establishedAttempt) {
                  sendToClient({
                    type: "status",
                    status: "disconnected",
                    message: "Voice session ended — reconnecting...",
                  });
                  // Previously the browser socket was left open here, so the UI
                  // still claimed to be listening over a session that no longer
                  // existed and only a manual "Reconnect Session" recovered.
                  // Closing it hands over to the client's automatic retry.
                  try {
                    clientWs.close(4001, "live-session-ended");
                  } catch {
                    /* already closing */
                  }
                }
              },
              onerror: (err: any) => {
                finish(() => reject(new Error(err?.message || `${model} error`)));
                sendToClient({
                  type: "error",
                  message: err?.message || "Live API error",
                });
              },
            },
          })
          .then((session) => finish(() => resolve(session)))
          .catch((err) => finish(() => reject(err)));
      });

    try {
      sendToClient({
        type: "status",
        status: "connecting",
        message: "Connecting to Gemini Live API...",
      });

      const failures: string[] = [];
      for (const model of LIVE_MODEL_CANDIDATES) {
        if (closed) return;
        try {
          liveSession = await connectWithTimeout(model);
          establishedAttempt = attemptCounter;
          console.log(`Gemini Live connected using model ${model}`);
          break;
        } catch (err: any) {
          const reason = err?.message || String(err);
          failures.push(`${model}: ${reason}`);
          console.warn(`Gemini Live model ${model} unavailable — ${reason}`);
        }
      }

      if (!liveSession) {
        throw new Error(
          !process.env.GEMINI_API_KEY
            ? "GEMINI_API_KEY is not set on the server. Add it to your .env file and restart."
            : `No Gemini Live model accepted the connection. ${failures.join(" | ")}`
        );
      }

      if (closed) {
        try {
          liveSession.close();
        } catch {
          // ignore
        }
        return;
      }

      sendToClient({
        type: "status",
        status: "ready",
        message: "Gemini Live connected and ready for speech.",
      });

      clientWs.on("message", (raw) => {
        if (!liveSession) return;
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === "audio" && data.audio) {
            liveSession.sendRealtimeInput({
              audio: { data: data.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else if (data.type === "text" && data.text) {
            liveSession.sendRealtimeInput({ text: data.text });
          } else if (data.type === "interrupt") {
            // Closing the audio stream is the documented way to cut the model
            // off mid-response. The previous code sent a zero-length audio
            // blob, which the Live API rejects as a malformed frame.
            liveSession.sendRealtimeInput({ audioStreamEnd: true });
          }
        } catch (e) {
          console.error("Error sending input to Live API session:", e);
        }
      });
    } catch (err: any) {
      console.error("Failed to initialize Gemini Live session:", err);
      sendToClient({
        type: "error",
        message: `Could not start Gemini Live session: ${err?.message || "Check API configuration"}`,
      });
    }
  });
}
