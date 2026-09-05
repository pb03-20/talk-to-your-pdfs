/**
 * Audio capture and playback utilities for Gemini Live (16kHz in, 24kHz out)
 */

export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const output = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return output.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export class LiveAudioPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime: number = 0;
  private isPlaying: boolean = false;
  private activeSources: AudioBufferSourceNode[] = [];
  // True once server signals the turn is done (no more audio coming)
  private turnDone: boolean = false;
  // Safety timer: unblock mic if turnComplete never arrives after audio ends
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Lazy initialized on user interaction
  }

  private getContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ sampleRate: 24000 });
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  public playChunk(base64Audio: string) {
    // New audio arriving — cancel any pending safety timer
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    // DO NOT reset turnDone here — it must survive across chunk arrivals
    try {
      const ctx = this.getContext();
      const arrayBuffer = base64ToArrayBuffer(base64Audio);
      const dataView = new DataView(arrayBuffer);
      const numSamples = dataView.byteLength / 2;
      const float32Array = new Float32Array(numSamples);

      for (let i = 0; i < numSamples; i++) {
        const int16 = dataView.getInt16(i * 2, true);
        float32Array[i] = int16 / 32768.0;
      }

      const audioBuffer = ctx.createBuffer(1, numSamples, 24000);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const currentTime = ctx.currentTime;
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.isPlaying = true;
      this.activeSources.push(source);

      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        if (this.activeSources.length === 0) {
          this.isPlaying = false;
          if (this.turnDone) {
            // Server already said turn is done — fire immediately
            this._complete();
          } else {
            // Wait for turnComplete, but unblock after 2s max (safety net)
            this.safetyTimer = setTimeout(() => {
              this.safetyTimer = null;
              this._complete();
            }, 2000);
          }
        }
      };
    } catch (e) {
      console.error("Failed to play audio chunk:", e);
    }
  }

  /**
   * Call when the server sends `turnComplete`.
   * - If audio is still playing: sets flag; completion fires when last chunk ends.
   * - If audio is already done: fires completion immediately.
   */
  public signalTurnComplete() {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.activeSources.length === 0) {
      this._complete();
    } else {
      this.turnDone = true;
    }
  }

  private _complete() {
    this.turnDone = false;
    if (this.onPlaybackComplete) {
      this.onPlaybackComplete();
    }
  }

  public onPlaybackComplete?: () => void;

  public stop() {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    for (const src of this.activeSources) {
      try { src.stop(); } catch (e) { /* already ended */ }
    }
    this.activeSources = [];
    this.nextStartTime = 0;
    this.isPlaying = false;
    this.turnDone = false;
    if (this.onPlaybackComplete) {
      this.onPlaybackComplete();
    }
  }

  public get playing(): boolean {
    return this.isPlaying;
  }
}

/**
 * Fallback browser text-to-speech
 */
export function speakWithBrowser(text: string, onEnd?: () => void) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/\[.*?\]/g, "").slice(0, 1000);
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = 1.05;
  utterance.pitch = 1.0;
  if (onEnd) utterance.onend = onEnd;
  window.speechSynthesis.speak(utterance);
}
