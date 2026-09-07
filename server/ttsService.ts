import { getGeminiClient } from "./geminiClient.js";
import { Modality } from "@google/genai";

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const MAX_TTS_TOTAL = 4000;
// Gemini TTS latency scales with chunk length, and chunks render in parallel,
// so smaller chunks finish sooner overall. Splitting stays on sentence
// boundaries, which keeps the prosody natural.
const MAX_CHUNK_CHARS = 350;
/** How many chunks to synthesize at once. Kept modest so a long answer does
 *  not burst straight through a free-tier per-minute quota. */
const CONCURRENCY = 3;

export interface TtsResult {
  audio: string;
  sampleRate: number;
  totalCharacters: number;
  chunksProcessed: number;
  isTruncated: boolean;
}

export function cleanTextForTts(raw: string): string {
  return raw
    // Drop bracketed citations and markdown emphasis so they are not read out.
    .replace(/\[.*?\]/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/[*_`#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkTextForTts(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return text ? [text] : [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sent of sentences) {
    if (current.length + sent.length + 1 <= maxChars) {
      current = (current + " " + sent).trim();
    } else {
      if (current) chunks.push(current);
      if (sent.length > maxChars) {
        for (let i = 0; i < sent.length; i += maxChars) {
          chunks.push(sent.slice(i, i + maxChars));
        }
        current = "";
      } else {
        current = sent;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function synthesizeChunk(chunk: string, voice: string): Promise<string | undefined> {
  const ai = getGeminiClient();
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: chunk }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      });
      const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audio) return audio;
    } catch (genErr: any) {
      const msg = genErr?.message || String(genErr);
      const isBusy = msg.includes("503") || msg.includes("UNAVAILABLE");
      // Parallel chunks can trip a per-minute quota; backing off recovers,
      // whereas giving up leaves the answer silent from that point on.
      const isRateLimited =
        msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");

      if ((isBusy || isRateLimited) && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, isRateLimited ? 2500 * attempt : 600));
        continue;
      }
      console.warn("TTS chunk failed:", msg.slice(0, 200));
      break;
    }
  }
  return undefined;
}

/**
 * Renders text to 24kHz PCM audio.
 *
 * Chunks are synthesized in parallel batches. Generating them one at a time
 * meant a long answer took ~40s before any sound played, which made "Read
 * Aloud" look broken.
 */
export async function synthesizeSpeech(rawText: string, voice = "Kore"): Promise<TtsResult> {
  let cleanText = cleanTextForTts(rawText);
  const isTruncated = cleanText.length > MAX_TTS_TOTAL;
  if (isTruncated) {
    cleanText = cleanText.slice(0, MAX_TTS_TOTAL);
  }

  const textChunks = chunkTextForTts(cleanText);
  if (textChunks.length === 0) {
    throw Object.assign(new Error("No speakable text found"), { status: 400 });
  }

  const rendered: (string | undefined)[] = new Array(textChunks.length);
  for (let i = 0; i < textChunks.length; i += CONCURRENCY) {
    const batch = textChunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((c) => synthesizeChunk(c, voice)));
    results.forEach((audio, idx) => {
      rendered[i + idx] = audio;
    });
  }

  // Keep audio in order and stop at the first gap so playback never jumps.
  const buffers: Buffer[] = [];
  for (const audio of rendered) {
    if (!audio) break;
    buffers.push(Buffer.from(audio, "base64"));
  }

  if (buffers.length === 0) {
    throw Object.assign(
      new Error(
        process.env.GEMINI_API_KEY
          ? "Failed to generate TTS audio"
          : "GEMINI_API_KEY is not set on the server."
      ),
      { status: 500 }
    );
  }

  return {
    audio: Buffer.concat(buffers).toString("base64"),
    sampleRate: 24000,
    totalCharacters: cleanText.length,
    chunksProcessed: buffers.length,
    isTruncated,
  };
}
