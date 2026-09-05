import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getGeminiClient } from "../server/geminiClient.js";
import { Modality } from "@google/genai";

function cleanTextForTts(raw: string): string {
  return raw.replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
}

function chunkTextForTts(text: string, maxChars = 800): string[] {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) {}
  }
  const { text, voice = "Kore" } = body || {};

  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    const ai = getGeminiClient();
    let cleanText = cleanTextForTts(text);
    const MAX_TTS_TOTAL = 4000;
    const isTruncated = cleanText.length > MAX_TTS_TOTAL;
    if (isTruncated) {
      cleanText = cleanText.slice(0, MAX_TTS_TOTAL);
    }

    const chunks = chunkTextForTts(cleanText, 800);
    if (chunks.length === 0) {
      return res.status(400).json({ error: "No speakable text found" });
    }

    const audioBuffers: Buffer[] = [];

    for (const chunk of chunks) {
      let chunkAudio: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
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
        break; // Return partial audio synthesized so far
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
}
