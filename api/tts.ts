import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getGeminiClient } from "../server/geminiClient.js";
import { Modality } from "@google/genai";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, voice = "Kore" } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    const ai = getGeminiClient();
    const cleanText = text.replace(/\[.*?\]/g, "").slice(0, 1000);

    let audioBase64: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-tts-preview",
          contents: [{ parts: [{ text: cleanText }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        });
        audioBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (audioBase64) break;
      } catch (genErr: any) {
        const is503 = genErr?.message?.includes("503") || genErr?.message?.includes("UNAVAILABLE");
        if (is503 && attempt === 1) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        throw genErr;
      }
    }

    if (audioBase64) {
      res.json({ audio: audioBase64, sampleRate: 24000 });
    } else {
      res.status(500).json({ error: "No audio generated from TTS" });
    }
  } catch (err: any) {
    console.warn("TTS generation warning:", err?.message || err);
    res.status(500).json({ error: err?.message || "TTS generation failed" });
  }
}
