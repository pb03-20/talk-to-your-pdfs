import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  X,
  Volume2,
  Radio,
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

const LISTENING_MESSAGE = "Listening... Speak naturally to ask about your PDFs.";

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
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const isMutedRef = useRef(false);
  const isAiSpeakingRef = useRef(false);
  const bargeInFramesRef = useRef(0);
  const lastInterruptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isModalOpenRef = useRef(false);
  const languageRef = useRef(responseLanguage);

  useEffect(() => {
    isAiSpeakingRef.current = isAiSpeaking;
  }, [isAiSpeaking]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    languageRef.current = responseLanguage;
  }, [responseLanguage]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  /**
   * Appends spoken text to the transcript.
   *
   * `isStreaming` marks the bubble that is still being written to. It used to
   * never be cleared, so every Gemini reply merged into one ever-growing bubble
   * and each new user phrase overwrote the previous one.
   */
  const appendTranscript = useCallback(
    (speaker: "user" | "gemini", textChunk: string, options?: { replace?: boolean }) => {
      const replace = options?.replace ?? false;
      setTranscripts((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.speaker === speaker && last.isStreaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, text: replace ? textChunk : last.text + textChunk },
          ];
        }
        return [
          ...prev,
          {
            id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            speaker,
            text: textChunk,
            isStreaming: true,
          },
        ];
      });
    },
    []
  );

  /** Closes the current bubble so the next chunk starts a new one. */
  const finalizeTranscript = useCallback((speaker?: "user" | "gemini") => {
    setTranscripts((prev) => {
      const last = prev[prev.length - 1];
      if (!last || !last.isStreaming) return prev;
      if (speaker && last.speaker !== speaker) return prev;
      if (!last.text.trim()) return prev.slice(0, -1);
      return [...prev.slice(0, -1), { ...last, isStreaming: false }];
    });
  }, []);

  const closeSocket = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const socket = wsRef.current;
    if (socket) {
      // Clear the ref before closing so this intentional close cannot schedule
      // an automatic reconnect from its onclose handler.
      wsRef.current = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }, []);

  const teardownAudio = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioCtxRef.current && inputAudioCtxRef.current.state !== "closed") {
      inputAudioCtxRef.current.close().catch(() => { });
    }
    inputAudioCtxRef.current = null;
    if (playerRef.current) {
      playerRef.current.dispose();
      playerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    closeSocket();
    teardownAudio();
    setIsConnected(false);
    setIsConnecting(false);
    setIsAiSpeaking(false);
    isAiSpeakingRef.current = false;
    bargeInFramesRef.current = 0;
  }, [closeSocket, teardownAudio]);

  /**
   * Builds the microphone graph and the playback engine.
   *
   * This runs once per modal session. It used to be rebuilt on every
   * reconnect, which re-prompted `getUserMedia` and left roughly a second of
   * dead air between turns.
   */
  const ensureAudioPipeline = useCallback(async (): Promise<boolean> => {
    if (processorRef.current && mediaStreamRef.current && playerRef.current) {
      return true;
    }
    teardownAudio();

    if (!navigator?.mediaDevices?.getUserMedia) {
      setIsConnecting(false);
      setErrorMessage("Microphone access is not supported by this browser environment.");
      return false;
    }

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
      return false;
    }

    if (!isModalOpenRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    mediaStreamRef.current = stream;

    const player = new LiveAudioPlayer();
    player.onPlaybackComplete = () => {
      setIsAiSpeaking(false);
      isAiSpeakingRef.current = false;
      bargeInFramesRef.current = 0;
      finalizeTranscript("gemini");
      setStatusMessage(LISTENING_MESSAGE);
    };
    playerRef.current = player;

    const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
    const inputCtx = new AudioCtxClass({ sampleRate: 16000 });
    inputAudioCtxRef.current = inputCtx;
    if (inputCtx.state === "suspended") {
      inputCtx.resume().catch(() => { });
    }

    const sourceNode = inputCtx.createMediaStreamSource(stream);
    sourceNodeRef.current = sourceNode;
    // 4096 samples at 16kHz is a ~256ms chunk
    const processor = inputCtx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      const socket = wsRef.current;
      if (isMutedRef.current || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (inputCtx.state === "suspended") {
        inputCtx.resume().catch(() => { });
      }

      const inputData = e.inputBuffer.getChannelData(0);

      if (isAiSpeakingRef.current) {
        // Keep listening while Gemini speaks so the user can barge in, but do
        // not forward the speaker's own output back into the session.
        let energy = 0;
        for (let i = 0; i < inputData.length; i++) energy += inputData[i] * inputData[i];
        const rms = Math.sqrt(energy / inputData.length);
        bargeInFramesRef.current = rms > 0.018 ? bargeInFramesRef.current + 1 : 0;

        // Three consecutive frames (~750ms) distinguishes real speech from
        // residual speaker audio that echo cancellation did not remove.
        if (
          bargeInFramesRef.current >= 3 &&
          Date.now() - lastInterruptRef.current > 1000
        ) {
          lastInterruptRef.current = Date.now();
          playerRef.current?.stop();
          setIsAiSpeaking(false);
          isAiSpeakingRef.current = false;
          finalizeTranscript("gemini");
          socket.send(JSON.stringify({ type: "interrupt" }));
          setStatusMessage("Listening to you...");
        } else {
          return;
        }
      }

      const pcmBuffer = floatTo16BitPCM(inputData);
      socket.send(
        JSON.stringify({ type: "audio", audio: arrayBufferToBase64(pcmBuffer) })
      );
    };

    sourceNode.connect(processor);
    processor.connect(inputCtx.destination);
    return true;
  }, [finalizeTranscript, teardownAudio]);

  /** Opens the signalling socket. Leaves the microphone graph untouched. */
  const connectSocket = useCallback(
    (isRetry: boolean) => {
      closeSocket();
      if (!isModalOpenRef.current) return;

      if (!isRetry) {
        reconnectAttemptsRef.current = 0;
      }
      setIsConnecting(true);
      setStatusMessage("Connecting to Gemini Live API...");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live-voice?workspaceId=${encodeURIComponent(
        workspaceId
      )}&responseLanguage=${encodeURIComponent(languageRef.current)}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        reconnectAttemptsRef.current = 0;
        setIsConnecting(false);
        setIsConnected(true);
        setErrorMessage(null);
        setStatusMessage(LISTENING_MESSAGE);
        if (inputAudioCtxRef.current?.state === "suspended") {
          inputAudioCtxRef.current.resume().catch(() => { });
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "status") {
            setStatusMessage(data.message || "Connected");
          } else if (data.type === "audio" && data.audio) {
            // The assistant has started replying — close the user's bubble.
            finalizeTranscript("user");
            setIsAiSpeaking(true);
            isAiSpeakingRef.current = true;
            playerRef.current?.playChunk(data.audio);
          } else if ((data.type === "outputTranscript" || data.type === "text") && data.text) {
            appendTranscript("gemini", data.text);
          } else if (data.type === "inputTranscript" && data.text) {
            appendTranscript("user", data.text);
          } else if (data.type === "turnComplete") {
            finalizeTranscript("user");
            // Let the player drain first; it fires onPlaybackComplete once the
            // speaker actually goes quiet, which avoids echo feedback.
            if (playerRef.current) {
              playerRef.current.signalTurnComplete();
            } else {
              setIsAiSpeaking(false);
              isAiSpeakingRef.current = false;
              finalizeTranscript("gemini");
              setStatusMessage(LISTENING_MESSAGE);
            }
          } else if (data.type === "interrupted") {
            playerRef.current?.stop();
            setIsAiSpeaking(false);
            isAiSpeakingRef.current = false;
            bargeInFramesRef.current = 0;
            finalizeTranscript("gemini");
            setStatusMessage(LISTENING_MESSAGE);
          } else if (data.type === "error") {
            setErrorMessage(data.message || "Live API error");
          }
        } catch (e) {
          console.error("Error parsing WebSocket message:", e);
        }
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        setStatusMessage("Voice connection interrupted — reconnecting...");
        // Some browsers do not emit close promptly after an error; closing
        // explicitly guarantees onclose starts the retry loop.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        // Ignore a close initiated by teardown or superseded by a newer socket.
        if (wsRef.current !== ws || !isModalOpenRef.current) return;

        wsRef.current = null;
        setIsConnected(false);
        setIsConnecting(false);
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;

        const attempt = reconnectAttemptsRef.current++;
        const retryDelay = Math.min(1000 * 2 ** attempt, 10000);
        setStatusMessage(
          `Voice connection interrupted — reconnecting in ${Math.ceil(retryDelay / 1000)}s...`
        );
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (isModalOpenRef.current) connectSocket(true);
        }, retryDelay);
      };
    },
    [appendTranscript, closeSocket, finalizeTranscript, workspaceId]
  );

  const startLiveSession = useCallback(async () => {
    setErrorMessage(null);
    setIsPermissionDenied(false);
    setIsConnecting(true);
    setStatusMessage("Requesting microphone access...");

    // Vercel's serverless functions cannot hold a WebSocket open.
    const hostname = window.location.hostname;
    if (hostname.includes(".vercel.app") || hostname.includes(".vercel.sh")) {
      setIsConnecting(false);
      setErrorMessage(
        "Live Voice requires a persistent server with WebSocket support and is not available on this serverless deployment. " +
        "The text chat, PDF upload, and TTS features work perfectly. To use Live Voice, run the app locally with 'npm run dev'."
      );
      return;
    }

    const ready = await ensureAudioPipeline();
    if (!ready || !isModalOpenRef.current) return;
    connectSocket(false);
  }, [connectSocket, ensureAudioPipeline]);

  // Connect when the modal opens; tear everything down when it closes.
  useEffect(() => {
    isModalOpenRef.current = isOpen;
    if (!isOpen) {
      cleanup();
      return;
    }

    startLiveSession();
    return () => {
      isModalOpenRef.current = false;
      cleanup();
    };
    // startLiveSession is stable for a given workspace; re-running on every
    // render would restart the microphone constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, workspaceId]);

  const handleInterrupt = () => {
    playerRef.current?.stop();
    setIsAiSpeaking(false);
    isAiSpeakingRef.current = false;
    bargeInFramesRef.current = 0;
    finalizeTranscript("gemini");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
    setStatusMessage(LISTENING_MESSAGE);
  };

  const handleLanguageChange = (value: string) => {
    setResponseLanguage(value);
    languageRef.current = value;
    // The language is applied when the Live session is created, so the socket
    // has to be rebuilt — but the microphone graph can stay as it is.
    if (processorRef.current && mediaStreamRef.current) {
      connectSocket(false);
    } else {
      // No microphone yet (denied, or never granted): reconnecting the socket
      // alone would report "listening" over a dead input.
      startLiveSession();
    }
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
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between gap-3 bg-zinc-50/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white flex items-center justify-center shrink-0">
              <Radio className={`w-4 h-4 ${isConnected ? "animate-pulse text-emerald-400" : ""}`} />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-900 flex items-center space-x-2">
                <span>Gemini Live Voice</span>
                <span
                  className={`w-2 h-2 rounded-full ${isConnected ? "bg-emerald-500 animate-ping" : "bg-zinc-300"
                    }`}
                />
              </h3>
              <p className="text-[11px] text-zinc-500 truncate">
                Grounding against {documentsCount} uploaded PDF{documentsCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-1.5 shrink-0">
            <label className="hidden sm:flex items-center gap-1.5 text-[10px] text-zinc-500">
              <span>Reply in</span>
              <select
                value={responseLanguage}
                onChange={(event) => handleLanguageChange(event.target.value)}
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
          <div className="relative w-24 h-24 my-2 flex items-center justify-center">
            {isConnected && (
              <>
                <div
                  className={`absolute inset-0 rounded-full transition-all duration-300 ${isAiSpeaking
                      ? "bg-indigo-500/20 animate-ping"
                      : isMuted
                        ? "bg-zinc-200"
                        : "bg-emerald-500/20 animate-pulse"
                    }`}
                />
                <div
                  className={`absolute inset-2 rounded-full transition-all duration-300 ${isAiSpeaking ? "bg-indigo-500/10" : "bg-emerald-500/10"
                    }`}
                />
              </>
            )}

            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-md ${isAiSpeaking
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

          <div className="mt-3">
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${isAiSpeaking
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
                  onClick={() => startLiveSession()}
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
                onClick={() => startLiveSession()}
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
                className={`p-3 rounded-2xl text-xs sm:text-sm leading-relaxed ${item.speaker === "user"
                    ? "bg-zinc-900 text-white ml-8 rounded-tr-xs"
                    : "bg-white text-zinc-800 border border-zinc-200 mr-8 rounded-tl-xs shadow-2xs"
                  }`}
              >
                <div className="text-[10px] font-semibold mb-1 opacity-70 uppercase tracking-wider">
                  {item.speaker === "user" ? "You (Voice)" : "Gemini (Spoken)"}
                </div>
                <div>{item.text.trim()}</div>
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
              className={`p-3 rounded-xl transition-colors ${isMuted
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
              onClick={() => startLiveSession()}
              disabled={isConnecting}
              className="p-3 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-xl transition-colors disabled:opacity-50"
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
