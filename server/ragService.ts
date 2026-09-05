import { getGeminiClient } from "./geminiClient.js";
import { workspaceStore } from "./workspaceStore.js";
import { DocumentChunk, SourceCitation, ChatMessage } from "./types.js";

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Simple fallback term-frequency vector if remote embedding fails or for hybrid search
function termOverlapScore(query: string, text: string): number {
  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (queryTerms.length === 0) return 0;

  const targetLower = text.toLowerCase();
  let matches = 0;
  for (const term of queryTerms) {
    if (targetLower.includes(term)) {
      matches++;
    }
  }
  return matches / queryTerms.length;
}

// Rate limit cooldown timestamp (ms) to avoid repeating 429 errors
let quotaCooldownUntil = 0;

export function generateLocalVector(text: string): number[] {
  // Resilient pseudo-embedding fallback (384-dimensional term hash)
  const vec = new Array(384).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let hash = 0;
    for (let c = 0; c < word.length; c++) {
      hash = (hash * 31 + word.charCodeAt(c)) & 0xffffffff;
    }
    const idx = Math.abs(hash) % 384;
    vec[idx] += 1 / (i + 1);
  }
  // Normalize
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export async function embedText(text: string): Promise<number[]> {
  const now = Date.now();
  if (now < quotaCooldownUntil) {
    return generateLocalVector(text);
  }

  const ai = getGeminiClient();
  try {
    const res = await ai.models.embedContent({
      model: "gemini-embedding-2-preview",
      contents: text.slice(0, 4000),
    });
    if (res.embeddings && res.embeddings[0]?.values) {
      return res.embeddings[0].values;
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
      console.warn(
        "Gemini embedding quota reached. Switching to local hash vectorizer for 30s to preserve speed and avoid rate-limit errors."
      );
      quotaCooldownUntil = Date.now() + 30000; // 30s cooldown
    } else {
      console.warn("Gemini embedding temporary error, using local vector fallback:", errMsg);
    }
  }

  return generateLocalVector(text);
}

export async function embedChunks(chunks: DocumentChunk[]): Promise<void> {
  // Budget remote embedding calls to stay well within free tier quota (100 req/min)
  const maxRemoteChunks = 25;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // If cooldown is active or beyond remote chunk limit, use local vector
    if (i >= maxRemoteChunks || Date.now() < quotaCooldownUntil) {
      chunk.embedding = generateLocalVector(chunk.text);
      continue;
    }

    try {
      chunk.embedding = await embedText(chunk.text);
      if (Date.now() < quotaCooldownUntil) {
        // Quota was exceeded in embedText, assign remaining immediately
        continue;
      }
      // Brief throttle pause (80ms) between calls to prevent burst rate limits
      await new Promise((resolve) => setTimeout(resolve, 80));
    } catch {
      chunk.embedding = generateLocalVector(chunk.text);
    }
  }
}

export interface SearchResult {
  chunk: DocumentChunk;
  score: number;
}

export async function searchRelevantChunks(
  workspaceId: string,
  query: string,
  topK: number = 5
): Promise<SearchResult[]> {
  const allChunks = workspaceStore.getChunks(workspaceId);
  if (allChunks.length === 0) return [];

  const queryEmbedding = await embedText(query);
  const queryLocalVector = generateLocalVector(query);

  const scored: SearchResult[] = allChunks.map((chunk) => {
    let semanticScore = 0;
    if (chunk.embedding && chunk.embedding.length > 0) {
      if (chunk.embedding.length === queryEmbedding.length && queryEmbedding.length > 384) {
        semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      } else if (chunk.embedding.length === 384) {
        semanticScore = cosineSimilarity(queryLocalVector, chunk.embedding);
      } else {
        semanticScore = cosineSimilarity(queryLocalVector, generateLocalVector(chunk.text));
      }
    } else {
      semanticScore = cosineSimilarity(queryLocalVector, generateLocalVector(chunk.text));
    }
    const keywordScore = termOverlapScore(query, chunk.text);
    // Hybrid score weighting: 70% semantic + 30% keyword
    const combinedScore = semanticScore > 0 ? semanticScore * 0.7 + keywordScore * 0.3 : keywordScore;
    return {
      chunk,
      score: combinedScore,
    };
  });

  // Sort descending
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function askGeminiRag(
  workspaceId: string,
  userPrompt: string,
  history: ChatMessage[] = []
): Promise<{ answer: string; sources: SourceCitation[] }> {
  const allDocs = workspaceStore.getDocuments(workspaceId);
  const allChunks = workspaceStore.getChunks(workspaceId);
  const relevantResults = await searchRelevantChunks(workspaceId, userPrompt, 6);

  if (allDocs.length === 0 && allChunks.length === 0) {
    return {
      answer: "No documents have been uploaded yet. Please upload one or more PDFs in the sidebar to start asking questions!",
      sources: [],
    };
  }

  // Filter out very low relevance if any documents exist
  const matchedChunks = relevantResults.filter((r) => r.score > 0.15);

  const sources: SourceCitation[] = (matchedChunks.length > 0 ? matchedChunks : relevantResults.slice(0, 2)).map((r) => ({
    docId: r.chunk.docId,
    filename: r.chunk.filename,
    pageNumber: r.chunk.pageNumber,
    snippet: r.chunk.text.slice(0, 240) + (r.chunk.text.length > 240 ? "..." : ""),
    score: Math.round(r.score * 100) / 100,
  }));

  // Construct context string
  const contextSections = (matchedChunks.length > 0 ? matchedChunks : relevantResults).map((r, idx) => {
    return `[Context Chunk ${idx + 1}]
Document: ${r.chunk.filename} (Page ${r.chunk.pageNumber})
Content:
${r.chunk.text}`;
  });

  const contextText = contextSections.join("\n\n---\n\n");

  const systemInstruction = `You are an expert document AI assistant called "Talk to Your PDFs".
You help users explore, analyze, and comprehend their uploaded PDF documents with grounded precision.

STRICT ACCURACY RULES:
1. Ground your answers strictly on the provided PDF context.
2. If the user asks about something NOT mentioned in the uploaded PDFs, explicitly say:
   "I could not find information about this in the uploaded PDFs."
   Do NOT extrapolate, hallucinate, or invent details not present in the text.
3. Cite the exact document name and page number whenever referencing facts (e.g. "[Report.pdf, Page 3]").
4. Maintain a helpful, conversational, professional tone. If the user asks a follow-up, use the chat history for context while staying grounded.
5. Format key points cleanly with markdown bullet points, bold keywords, or short paragraphs for readability.`;

  // Recent conversation context
  const recentHistory = history.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");

  const prompt = `Here is the relevant excerpt from the user's uploaded PDFs:
=== BEGIN CONTEXT ===
${contextText || "(No matching content found for this query in the indexed PDFs)"}
=== END CONTEXT ===

${recentHistory ? `Recent Conversation History:\n${recentHistory}\n` : ""}
User's Question: "${userPrompt}"

Please answer the question thoroughly and accurately based on the context above. Always mention the relevant document name(s) and page number(s). If the context doesn't contain the answer, state that clearly.`;

  const ai = getGeminiClient();
  const candidateModels = ["gemini-2.5-flash", "gemini-flash-latest"];

  let answerText = "";
  for (const modelName of candidateModels) {
    let succeeded = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            systemInstruction,
            temperature: 0.2, // Low temperature for high factual grounding
          },
        });
        if (res.text) {
          answerText = res.text.trim();
          succeeded = true;
          break;
        }
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        const is503 = errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("high demand");

        if (is503 && attempt === 1) {
          // Brief pause before retry on temporary high-demand spikes
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }

        if (is503) {
          console.info(`Model ${modelName} temporarily at capacity (503), switching to fallback model.`);
        } else {
          console.info(`Model ${modelName} call bypassed, trying next candidate.`);
        }
        break; // break to next candidate model
      }
    }
    if (succeeded) break;
  }

  if (!answerText) {
    answerText = "I encountered a temporary issue processing your request with the AI service. Please try asking again in a moment.";
  }

  return {
    answer: answerText,
    sources,
  };
}
