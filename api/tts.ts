import type { VercelRequest, VercelResponse } from "@vercel/node";
import { synthesizeSpeech } from "../server/ttsService.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { /* keep raw body */ }
  }
  const { text, voice = "Kore" } = body || {};

  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    res.json(await synthesizeSpeech(text, voice));
  } catch (err: any) {
    console.warn("TTS generation warning:", err?.message || err);
    res.status(err?.status || 500).json({ error: err?.message || "TTS generation failed" });
  }
}
