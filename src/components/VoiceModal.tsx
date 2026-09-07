import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  X,
  Volume2,
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
      if (!isRetry) {
        setStatusMessage("Connecting to Gemini Live API...");
      }

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
        // The first retry is near-instant so a session that ends mid-conversation
        // feels like a brief pause rather than a dropped call. Later attempts
        // back off, so a genuine outage does not hammer the server.
        const retryDelay = attempt === 0 ? 250 : Math.min(1000 * 2 ** attempt, 10000);
        setStatusMessage(
          attempt === 0
            ? "Reconnecting — keep talking, your microphone is still on..."
            : `Voice connection interrupted — reconnecting in ${Math.ceil(retryDelay / 1000)}s...`
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

  const statusLabel = isAiSpeaking
    ? "Speaking"
    : isMuted
      ? "Muted"
      : isConnected
        ? "Listening"
        : "Connecting";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label="Live voice conversation"
    >
      <div
        id="modal-voice-live"
        className="bg-surface rounded-2xl w-full max-w-lg shadow-overlay overflow-hidden flex flex-col h-[620px] max-h-[92vh] rise-in"
      >
        {/* Header */}
        <div className="h-14 shrink-0 px-4 flex items-center justify-between gap-3 border-b border-line">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                isAiSpeaking
                  ? "bg-ink"
                  : isConnected
                    ? "bg-positive"
                    : "bg-ink-3"
              } ${isConnected && !isAiSpeaking ? "animate-pulse" : ""}`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-ink leading-tight">Live voice</h3>
              <p className="text-[11px] text-ink-3 leading-tight truncate">
                {documentsCount === 0
                  ? "No documents loaded"
                  : `Grounded on ${documentsCount} document${documentsCount === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <label className="hidden sm:flex items-center gap-1.5 text-[11px] text-ink-3">
              <span className="sr-only">Reply language</span>
              <select
                value={responseLanguage}
                onChange={(event) => handleLanguageChange(event.target.value)}
                className="bg-surface border border-line rounded-lg px-2 py-1 text-[11.5px] text-ink-2 hover:border-line-strong outline-none transition-colors cursor-pointer"
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
              title="Open in a new tab for full microphone permissions"
              aria-label="Open in a new tab"
              className="p-2 text-ink-3 hover:text-ink hover:bg-sunken rounded-lg transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            <button
              id="btn-close-voice-modal"
              onClick={onClose}
              aria-label="Close voice conversation"
              className="p-2 text-ink-3 hover:text-ink hover:bg-sunken rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Status */}
        <div className="shrink-0 px-6 pt-7 pb-6 flex flex-col items-center text-center border-b border-line">
          <div className="relative w-20 h-20 flex items-center justify-center">
            {isConnected && !isMuted && (
              <span
                className={`absolute inset-0 rounded-full ${
                  isAiSpeaking ? "bg-ink/10 animate-ping" : "bg-positive/15 animate-pulse"
                }`}
                aria-hidden="true"
              />
            )}
            <div
              className={`relative w-16 h-16 rounded-full flex items-center justify-center transition-colors ${
                isMuted
                  ? "bg-sunken text-ink-3"
                  : isAiSpeaking
                    ? "bg-accent text-accent-ink"
                    : isConnected
                      ? "bg-accent text-accent-ink"
                      : "bg-sunken text-ink-3"
              }`}
            >
              {isAiSpeaking ? (
                <Volume2 className="w-6 h-6" strokeWidth={2.1} />
              ) : isMuted ? (
                <MicOff className="w-6 h-6" strokeWidth={2.1} />
              ) : (
                <Mic className="w-6 h-6" strokeWidth={2.1} />
              )}
            </div>
          </div>

          <p className="mt-4 text-[13.5px] font-medium text-ink">{statusLabel}</p>
          <p className="mt-1 text-[12px] text-ink-3 max-w-xs leading-relaxed">{statusMessage}</p>

          {isPermissionDenied ? (
            <div className="mt-4 w-full rounded-xl bg-caution-bg px-3.5 py-3 text-left">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-caution">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Microphone access required
              </div>
              <p className="mt-1.5 text-[11.5px] text-caution/90 leading-relaxed">
                Your browser blocked the microphone. If this is an embedded preview, open the
                app in its own tab to allow audio.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  id="btn-retry-mic-permission"
                  onClick={() => startLiveSession()}
                  className="px-3 py-1.5 rounded-lg bg-accent text-accent-ink text-[11.5px] font-medium hover:bg-accent-hover transition-colors"
                >
                  Retry
                </button>
                <a
                  id="btn-open-voice-standalone"
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line bg-surface text-ink text-[11.5px] font-medium hover:border-line-strong transition-colors"
                >
                  New tab
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          ) : errorMessage ? (
            <div
              role="alert"
              className="mt-4 w-full rounded-xl bg-critical-bg px-3.5 py-3 flex items-start gap-2 text-left"
            >
              <AlertCircle className="w-4 h-4 text-critical mt-px shrink-0" />
              <p className="flex-1 text-[11.5px] text-critical leading-relaxed">{errorMessage}</p>
              <button
                onClick={() => startLiveSession()}
                className="px-2.5 py-1 rounded-md bg-surface text-critical text-[11px] font-medium hover:bg-sunken transition-colors shrink-0"
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-2.5">
          <p className="text-[10.5px] font-medium text-ink-3 uppercase tracking-[0.06em] flex items-center gap-1.5">
            <MessageSquare className="w-3 h-3" />
            Transcript
          </p>

          {transcripts.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-ink-3">
              Your conversation will appear here as you speak.
            </p>
          ) : (
            transcripts.map((item) => (
              <div
                key={item.id}
                className={
                  item.speaker === "user"
                    ? "ml-8 rounded-2xl rounded-br-md bg-accent text-accent-ink px-3.5 py-2.5"
                    : "mr-8 rounded-2xl rounded-bl-md bg-sunken text-ink px-3.5 py-2.5"
                }
              >
                <p
                  className={`text-[10px] font-medium uppercase tracking-[0.06em] mb-1 ${
                    item.speaker === "user" ? "opacity-60" : "text-ink-3"
                  }`}
                >
                  {item.speaker === "user" ? "You" : "Assistant"}
                </p>
                <p className="text-[13px] leading-relaxed break-words">{item.text.trim()}</p>
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* Controls */}
        <div className="shrink-0 px-4 py-3 border-t border-line flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              id="btn-voice-mute"
              onClick={toggleMute}
              title={isMuted ? "Unmute microphone" : "Mute microphone"}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
              className={`p-2.5 rounded-lg transition-colors ${
                isMuted
                  ? "bg-critical-bg text-critical"
                  : "text-ink-2 hover:text-ink hover:bg-sunken"
              }`}
            >
              {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>

            {isAiSpeaking && (
              <button
                id="btn-voice-interrupt"
                onClick={handleInterrupt}
                title="Interrupt"
                className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[12px] font-medium text-ink-2 hover:text-ink hover:bg-sunken transition-colors"
              >
                <Square className="w-3 h-3 fill-current" />
                Interrupt
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              id="btn-voice-reconnect"
              onClick={() => startLiveSession()}
              disabled={isConnecting}
              title="Reconnect session"
              aria-label="Reconnect session"
              className="p-2.5 rounded-lg text-ink-3 hover:text-ink hover:bg-sunken transition-colors disabled:opacity-40"
            >
              <RotateCcw className={`w-4 h-4 ${isConnecting ? "animate-spin" : ""}`} />
            </button>

            <button
              id="btn-voice-done"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-ink text-[12.5px] font-medium transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
