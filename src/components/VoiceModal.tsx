import React, { useState, useEffect, useRef } from "react";
import {
  Mic,
  MicOff,
  X,
  Volume2,
  Radio,
  Sparkles,
  RotateCcw,
  AlertCircle,
  Square,
  MessageSquare,
  ExternalLink,
} from "lucide-react";
import {
  floatTo16BitPCM,
  arrayBufferToBase64,
  LiveAudioPlayer,
} from "../lib/audioUtils";

interface TranscriptItem {
  id: string;
  speaker: "user" | "gemini";
  text: string;
  isStreaming?: boolean;
}

interface VoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
  documentsCount: number;
}

export const VoiceModal: React.FC<VoiceModalProps> = ({
  isOpen,
  onClose,
  workspaceId,
  documentsCount,
}) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Initializing voice session...");
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPermissionDenied, setIsPermissionDenied] = useState(false);
  const [responseLanguage, setResponseLanguage] = useState("auto");

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const isMutedRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const isAiSpeakingRef = useRef(false);
  const bargeInFramesRef = useRef(0);
  const lastInterruptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isModalOpenRef = useRef(false);
  useEffect(() => {
    isAiSpeakingRef.current = isAiSpeaking;
  }, [isAiSpeaking]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  // Connect when modal opens
  useEffect(() => {
    isModalOpenRef.current = isOpen;
    if (!isOpen) {
      cleanup();
      return;
    }

    startLiveSession();

    return () => {
      cleanup();
    };
  }, [isOpen, workspaceId]);

  const cleanup = () => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (wsRef.current) {
      const socket = wsRef.current;
      // Clear the ref before closing so this intentional close cannot schedule
      // an automatic reconnect from its onclose handler.
      wsRef.current = null;
      socket.close();
    }

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (inputAudioCtxRef.current && inputAudioCtxRef.current.state !== "closed") {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }

    if (playerRef.current) {
      playerRef.current.stop();
      playerRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
    setIsAiSpeaking(false);
    isAiSpeakingRef.current = false;
    bargeInFramesRef.current = 0;
  };

  const startLiveSession = async (
    isReconnect = false,
    languageOverride = responseLanguage,
  ) => {
    cleanup();
    if (!isReconnect) {
      reconnectAttemptsRef.current = 0;
    }
    setIsConnecting(true);
    setErrorMessage(null);
    setIsPermissionDenied(false);
    setStatusMessage("Connecting to Gemini Live API...");

    // Detect serverless deployment (Vercel doesn't support WebSockets)
    const hostname = window.location.hostname;
    const isServerless = hostname.includes(".vercel.app") || hostname.includes(".vercel.sh");
    if (isServerless) {
      setIsConnecting(false);
      setErrorMessage(
        "Live Voice requires a persistent server with WebSocket support and is not available on this serverless deployment. " +
        "The text chat, PDF upload, and TTS features work perfectly. To use Live Voice, run the app locally with 'npm run dev'."
      );
      return;
    }

    try {
      // 1. Check browser microphone support
      if (!navigator?.mediaDevices?.getUserMedia) {
        setIsConnecting(false);
        setIsConnected(false);
        setErrorMessage("Microphone access is not supported by this browser environment.");
        return;
      }

      // 2. Request microphone stream (16kHz linear PCM)
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (micErr: any) {
        const isDenied =
          micErr?.name === "NotAllowedError" ||
          micErr?.name === "PermissionDeniedError" ||
          micErr?.message?.toLowerCase().includes("permission") ||
          micErr?.message?.toLowerCase().includes("not allowed");

        console.warn("Microphone access prompt result:", micErr?.name || micErr?.message);
        setIsConnecting(false);
        setIsConnected(false);
        setIsPermissionDenied(isDenied);
        setErrorMessage(
          isDenied
            ? "Microphone access was denied. Please allow microphone permissions in your browser, or open in a new tab."
            : `Microphone error: ${micErr?.message || "Could not access microphone."}`
        );
        return;
      }
      mediaStreamRef.current = stream;

      // 3. Initialize audio player (24kHz)
      playerRef.current = new LiveAudioPlayer();
      playerRef.current.onPlaybackComplete = () => {
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;
        if (inputAudioCtxRef.current && inputAudioCtxRef.current.state === "suspended") {
          inputAudioCtxRef.current.resume().catch(() => {});
        }
        setStatusMessage("Listening... Speak naturally to ask about your PDFs.");
      };

      // Optional browser speech recognition for real-time user voice transcript
      const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRec) {
        try {
          const rec = new SpeechRec();
          rec.continuous = true;
          rec.interimResults = true;
          // Use the browser's preferred language for the optional transcript.
          // Gemini itself receives the raw audio and detects the spoken language.
          rec.lang = navigator.language || "en-US";
          rec.onresult = (evt: any) => {
            let fullText = "";
            for (let i = evt.resultIndex; i < evt.results.length; i++) {
              fullText += evt.results[i][0].transcript;
            }
            if (fullText.trim()) {
              appendTranscript("user", fullText.trim());
            }
          };
          rec.onend = () => {
            if (isOpen && !isMutedRef.current && recognitionRef.current) {
              try {
                rec.start();
              } catch (e) {}
            }
          };
          rec.start();
          recognitionRef.current = rec;
        } catch (recErr) {
          console.warn("Speech recognition optional error:", recErr);
        }
      }

      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtxClass({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;
      if (inputCtx.state === "suspended") {
        inputCtx.resume().catch(() => {});
      }

      const source = inputCtx.createMediaStreamSource(stream);
      // 4096 buffer size at 16kHz is ~256ms chunk
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // 4. Establish WebSocket connection to backend
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live-voice?workspaceId=${encodeURIComponent(
        workspaceId
      )}&responseLanguage=${encodeURIComponent(languageOverride)}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setIsConnecting(false);
        setIsConnected(true);
        setStatusMessage("Listening... Speak naturally to ask about your PDFs.");
        if (inputCtx.state === "suspended") {
          inputCtx.resume().catch(() => {});
        }

        // Hook up audio processor once connected
        processor.onaudioprocess = (e) => {
          // Continue listening while Gemini speaks. If the user starts talking,
          // detect sustained voice activity and immediately let them barge in.
          if (
            isMutedRef.current ||
            !wsRef.current ||
            wsRef.current.readyState !== WebSocket.OPEN
          ) {
            return;
          }

          if (inputCtx.state === "suspended") {
            inputCtx.resume().catch(() => {});
          }

          const inputData = e.inputBuffer.getChannelData(0);
          const pcmBuffer = floatTo16BitPCM(inputData);
          const base64Audio = arrayBufferToBase64(pcmBuffer);

          if (isAiSpeakingRef.current) {
            let energy = 0;
            for (let i = 0; i < inputData.length; i++) energy += inputData[i] * inputData[i];
            const rms = Math.sqrt(energy / inputData.length);
            bargeInFramesRef.current = rms > 0.018 ? bargeInFramesRef.current + 1 : 0;

            // Three consecutive audio frames (~750ms) helps distinguish real
            // speech from residual speaker audio despite echo cancellation.
            if (
              bargeInFramesRef.current >= 3 &&
              Date.now() - lastInterruptRef.current > 1000
            ) {
              lastInterruptRef.current = Date.now();
              playerRef.current?.stop();
              setIsAiSpeaking(false);
              isAiSpeakingRef.current = false;
              wsRef.current.send(JSON.stringify({ type: "interrupt" }));
              setStatusMessage("Listening to you...");
            } else {
              // Keep Gemini from receiving its own speaker output before a
              // genuine user interruption is detected.
              return;
            }
          }

          wsRef.current.send(
            JSON.stringify({
              type: "audio",
              audio: base64Audio,
            })
          );
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "status") {
            setStatusMessage(data.message || "Connected");
          } else if (data.type === "audio" && data.audio) {
            setIsAiSpeaking(true);
            isAiSpeakingRef.current = true;
            playerRef.current?.playChunk(data.audio);
          } else if ((data.type === "outputTranscript" || data.type === "text") && data.text) {
            appendTranscript("gemini", data.text);
          } else if (data.type === "inputTranscript" && data.text) {
            appendTranscript("user", data.text);
          } else if (data.type === "turnComplete") {
            // Tell the player the turn is done. It will fire onPlaybackComplete
            // once the audio queue fully drains — preventing mic from opening
            // while the speaker is still playing (echo feedback).
            if (playerRef.current) {
              playerRef.current.signalTurnComplete();
            } else {
              setIsAiSpeaking(false);
              isAiSpeakingRef.current = false;
              if (inputAudioCtxRef.current && inputAudioCtxRef.current.state === "suspended") {
                inputAudioCtxRef.current.resume().catch(() => {});
              }
              setStatusMessage("Listening... Speak naturally to ask about your PDFs.");
            }
          } else if (data.type === "interrupted") {
            playerRef.current?.stop();
            setIsAiSpeaking(false);
            isAiSpeakingRef.current = false;
            bargeInFramesRef.current = 0;
            if (inputAudioCtxRef.current && inputAudioCtxRef.current.state === "suspended") {
              inputAudioCtxRef.current.resume().catch(() => {});
            }
            setStatusMessage("Listening... Speak naturally to ask about your PDFs.");
          } else if (data.type === "error") {
            setErrorMessage(data.message || "Live API error");
          }
        } catch (e) {
          console.error("Error parsing WebSocket message:", e);
        }
      };

      ws.onerror = (err) => {
        console.warn("WebSocket connection state:", err);
        // The close event below schedules a retry. Keep the conversation UI
        // usable rather than asking the user to restart it manually.
        setStatusMessage("Voice connection interrupted — reconnecting...");
        // Some browsers do not emit close promptly after a WebSocket error.
        // Closing explicitly guarantees that onclose starts the retry loop.
        try {
          ws.close();
        } catch (_) {}
      };

      ws.onclose = () => {
        // Ignore a close initiated by cleanup/onClose or by a newer session.
        if (wsRef.current !== ws || !isModalOpenRef.current) return;

        wsRef.current = null;
        setIsConnected(false);
        setIsConnecting(false);
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;

        const attempt = reconnectAttemptsRef.current++;
        const retryDelay = Math.min(1000 * 2 ** attempt, 10000);
        setStatusMessage(`Voice connection interrupted — reconnecting in ${Math.ceil(retryDelay / 1000)}s...`);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (isModalOpenRef.current) startLiveSession(true);
        }, retryDelay);
      };
    } catch (err: any) {
      console.warn("Live voice session initialization:", err?.message || err);
      setIsConnecting(false);
      setIsConnected(false);
      setErrorMessage(`Failed to initialize session: ${err?.message || "Error"}`);
    }
  };

  const appendTranscript = (speaker: "user" | "gemini", textChunk: string) => {
    setTranscripts((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.speaker === speaker && last.isStreaming) {
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            text: last.text + " " + textChunk.trim(),
          },
        ];
      }
      return [
        ...prev,
        {
          id: `t_${Date.now()}_${Math.random()}`,
          speaker,
          text: textChunk.trim(),
          isStreaming: true,
        },
      ];
    });
  };

  const handleInterrupt = () => {
    if (playerRef.current) {
      playerRef.current.stop();
    }
    setIsAiSpeaking(false);
    isAiSpeakingRef.current = false;
    bargeInFramesRef.current = 0;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
    setStatusMessage("Listening... Speak naturally to ask about your PDFs.");
  };

  const toggleMute = () => {
    setIsMuted((prev) => !prev);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        id="modal-voice-live"
        className="bg-white border border-zinc-200 rounded-3xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col h-[640px] max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between bg-zinc-50/50">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white flex items-center justify-center">
              <Radio className={`w-4 h-4 ${isConnected ? "animate-pulse text-emerald-400" : ""}`} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 flex items-center space-x-2">
                <span>Gemini Live Voice</span>
                <span
                  className={`w-2 h-2 rounded-full ${
                    isConnected ? "bg-emerald-500 animate-ping" : "bg-zinc-300"
                  }`}
                />
              </h3>
              <p className="text-[11px] text-zinc-500">
                Grounding against {documentsCount} uploaded PDF{documentsCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <label className="hidden sm:flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span>Reply in</span>
            <select
              value={responseLanguage}
              onChange={(event) => {
                setResponseLanguage(event.target.value);
                // A new Live session applies the selected voice language.
                startLiveSession(false, event.target.value);
              }}
              className="bg-white border border-zinc-200 rounded-lg px-1.5 py-1 text-zinc-700 outline-none"
              title="Choose Auto to match the language you speak"
            >
              <option value="auto">Auto</option>
              <option value="English">English</option>
              <option value="Hindi">Hindi</option>
              <option value="Bengali">Bengali</option>
              <option value="Tamil">Tamil</option>
              <option value="Telugu">Telugu</option>
              <option value="Marathi">Marathi</option>
            </select>
          </label>

          <div className="flex items-center space-x-1.5">
            <a
              id="btn-open-voice-newtab"
              href={window.location.href}
              target="_blank"
              rel="noopener noreferrer"
              title="Open app in a new browser tab for full microphone permissions"
              className="p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-xl transition-colors flex items-center"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            <button
              id="btn-close-voice-modal"
              onClick={onClose}
              className="p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-xl transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Live Audio Visualizer / Status Area */}
        <div className="p-6 bg-gradient-to-b from-zinc-50 to-white border-b border-zinc-100 flex flex-col items-center text-center">
          {/* Wave animation */}
          <div className="relative w-24 h-24 my-2 flex items-center justify-center">
            {isConnected && (
              <>
                <div
                  className={`absolute inset-0 rounded-full transition-all duration-300 ${
                    isAiSpeaking
                      ? "bg-indigo-500/20 animate-ping"
                      : isMuted
                      ? "bg-zinc-200"
                      : "bg-emerald-500/20 animate-pulse"
                  }`}
                />
                <div
                  className={`absolute inset-2 rounded-full transition-all duration-300 ${
                    isAiSpeaking ? "bg-indigo-500/10" : "bg-emerald-500/10"
                  }`}
                />
              </>
            )}

            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-md ${
                isAiSpeaking
                  ? "bg-indigo-600 text-white shadow-indigo-200"
                  : isMuted
                  ? "bg-zinc-200 text-zinc-500"
                  : isConnected
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-400"
              }`}
            >
              {isAiSpeaking ? (
                <Volume2 className="w-7 h-7 animate-bounce" />
              ) : isMuted ? (
                <MicOff className="w-7 h-7" />
              ) : (
                <Mic className="w-7 h-7" />
              )}
            </div>
          </div>

          {/* Status badge */}
          <div className="mt-3">
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                isAiSpeaking
                  ? "bg-indigo-50 text-indigo-700 border border-indigo-200/60"
                  : isConnected
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200/60"
                  : "bg-zinc-100 text-zinc-600"
              }`}
            >
              {isAiSpeaking
                ? "AI Speaking — you can interrupt"
                : isMuted
                ? "Microphone Muted"
                : isConnected
                ? "Two-way listening"
                : "Connecting..."}
            </span>
            <p className="text-xs text-zinc-500 mt-1 max-w-sm">{statusMessage}</p>
            {responseLanguage === "auto" && (
              <p className="text-[10px] text-zinc-400 mt-1">Replies follow the language you speak.</p>
            )}
          </div>

          {isPermissionDenied ? (
            <div className="mt-4 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs text-left w-full space-y-2">
              <div className="flex items-center space-x-2 font-semibold text-amber-900">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>Microphone Access Required</span>
              </div>
              <p className="text-amber-800 leading-relaxed">
                Browser blocked microphone permissions. If you are viewing inside an embedded preview iframe, open the app in a new tab to enable audio conversation:
              </p>
              <div className="pt-1 flex items-center space-x-2">
                <button
                  id="btn-retry-mic-permission"
                  onClick={startLiveSession}
                  className="px-3 py-1.5 bg-amber-700 text-white font-medium rounded-lg text-xs hover:bg-amber-800 transition-colors shadow-2xs"
                >
                  Retry Permission
                </button>
                <a
                  id="btn-open-voice-standalone"
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 bg-white text-amber-900 border border-amber-300 font-medium rounded-lg text-xs hover:bg-amber-100 transition-colors inline-flex items-center space-x-1"
                >
                  <span>Open in New Tab</span>
                  <ExternalLink className="w-3.5 h-3.5 ml-1" />
                </a>
              </div>
            </div>
          ) : errorMessage ? (
            <div className="mt-3 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center space-x-2 text-left w-full">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <div className="flex-1">{errorMessage}</div>
              <button
                onClick={startLiveSession}
                className="px-2 py-1 bg-white text-rose-700 font-medium rounded shadow-2xs text-[11px] hover:bg-rose-100"
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>

        {/* Live Transcript Feed */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3 bg-zinc-50/40">
          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Live Transcript</span>
          </div>

          {transcripts.length === 0 ? (
            <div className="py-12 text-center text-xs text-zinc-400">
              User speech and Gemini answers will appear here in real-time as you speak...
            </div>
          ) : (
            transcripts.map((item) => (
              <div
                key={item.id}
                className={`p-3 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                  item.speaker === "user"
                    ? "bg-zinc-900 text-white ml-8 rounded-tr-xs"
                    : "bg-white text-zinc-800 border border-zinc-200 mr-8 rounded-tl-xs shadow-2xs"
                }`}
              >
                <div className="text-[10px] font-semibold mb-1 opacity-70 uppercase tracking-wider">
                  {item.speaker === "user" ? "You (Voice)" : "Gemini (Spoken)"}
                </div>
                <div>{item.text}</div>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* Action Controls Bar */}
        <div className="p-4 bg-white border-t border-zinc-200 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <button
              id="btn-voice-mute"
              onClick={toggleMute}
              className={`p-3 rounded-xl transition-colors ${
                isMuted
                  ? "bg-rose-100 text-rose-700"
                  : "bg-zinc-100 hover:bg-zinc-200 text-zinc-700"
              }`}
              title={isMuted ? "Unmute Mic" : "Mute Mic"}
            >
              {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {isAiSpeaking && (
              <button
                id="btn-voice-interrupt"
                onClick={handleInterrupt}
                className="flex items-center space-x-1.5 px-3 py-2.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-medium transition-colors"
                title="Interrupt AI Speech"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Interrupt</span>
              </button>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <button
              id="btn-voice-reconnect"
              onClick={startLiveSession}
              disabled={isConnecting}
              className="p-3 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-xl transition-colors"
              title="Reconnect Session"
            >
              <RotateCcw className={`w-4 h-4 ${isConnecting ? "animate-spin" : ""}`} />
            </button>

            <button
              id="btn-voice-done"
              onClick={onClose}
              className="px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-medium rounded-xl transition-colors shadow-xs"
            >
              Done / Return to Chat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
