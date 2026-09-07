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

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// Resilient pseudo-embedding fallback (term-hash bag of words)
function hashVector(text: string, dims: number): number[] {
  const vec = new Array(dims).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let hash = 0;
    for (let c = 0; c < word.length; c++) {
      hash = (hash * 31 + word.charCodeAt(c)) & 0xffffffff;
    }
    const idx = Math.abs(hash) % dims;
    vec[idx] += 1 / (i + 1);
  }
  return normalize(vec);
}

const EMBED_MODEL = "gemini-embedding-001";
// Every vector in the index must live in the same space for cosine similarity
// to mean anything, so remote and fallback vectors share one dimensionality.
export const EMBED_DIMS = 768;

export function generateLocalVector(text: string): number[] {
  return hashVector(text, EMBED_DIMS);
}

/**
 * Embeds a batch of texts in a single request. Returns null when the remote
 * call fails so the caller can decide whether to fall back.
 */
async function embedBatchRemote(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"
): Promise<number[][] | null> {
  if (Date.now() < quotaCooldownUntil) return null;

  const ai = getGeminiClient();
  try {
    const res = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: texts.map((t) => t.slice(0, 4000)),
      config: { outputDimensionality: EMBED_DIMS, taskType },
    });
    const vectors = res.embeddings?.map((e) => e.values).filter(Boolean) as number[][] | undefined;
    if (vectors && vectors.length === texts.length) {
      // gemini-embedding-001 does not re-normalise truncated vectors.
      return vectors.map(normalize);
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
      console.warn(
        "Gemini embedding quota reached. Falling back to the local hash vectorizer for 30s."
      );
      quotaCooldownUntil = Date.now() + 30000;
    } else {
      console.warn("Gemini embedding error, using local vector fallback:", errMsg);
    }
  }
  return null;
}

export async function embedText(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_QUERY"
): Promise<{ vector: number[]; remote: boolean }> {
  const batch = await embedBatchRemote([text], taskType);
  if (batch) return { vector: batch[0], remote: true };
  return { vector: generateLocalVector(text), remote: false };
}

/**
 * Embeds every chunk in the document. Batching keeps this to a handful of
 * requests even for large PDFs, so the whole index shares one vector space
 * instead of the first few chunks being semantically searchable and the
 * remainder falling back to keyword-grade hash vectors.
 */
export async function embedChunks(chunks: DocumentChunk[]): Promise<void> {
  const BATCH_SIZE = 32;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatchRemote(
      batch.map((c) => c.text),
      "RETRIEVAL_DOCUMENT"
    );

    batch.forEach((chunk, idx) => {
      chunk.embedding = vectors ? vectors[idx] : generateLocalVector(chunk.text);
      chunk.embeddingKind = vectors ? "remote" : "local";
    });

    // Gentle throttle between batches to stay inside free-tier burst limits.
    if (vectors && i + BATCH_SIZE < chunks.length) {
      await new Promise((resolve) => setTimeout(resolve, 120));
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

  const { vector: queryRemoteVector, remote } = await embedText(query, "RETRIEVAL_QUERY");
  // A local hash vector is only comparable with other local hash vectors, so
  // keep one of each and match every chunk against the vector from its own space.
  const queryLocalVector = remote ? generateLocalVector(query) : queryRemoteVector;

  const scored: SearchResult[] = allChunks.map((chunk) => {
    const isRemoteChunk =
      chunk.embeddingKind === "remote" ||
      (chunk.embeddingKind === undefined && chunk.embedding?.length === EMBED_DIMS && remote);

    let semanticScore = 0;
    if (chunk.embedding && chunk.embedding.length > 0) {
      const queryVector = isRemoteChunk && remote ? queryRemoteVector : queryLocalVector;
      if (queryVector.length === chunk.embedding.length) {
        semanticScore = cosineSimilarity(queryVector, chunk.embedding);
      } else {
        // Dimensions from an older index: re-derive a comparable local vector.
        semanticScore = cosineSimilarity(queryLocalVector, generateLocalVector(chunk.text));
      }
    } else {
      semanticScore = cosineSimilarity(queryLocalVector, generateLocalVector(chunk.text));
    }

    const keywordScore = termOverlapScore(query, chunk.text);
    // Hybrid score weighting: 70% semantic + 30% keyword
    const combinedScore = semanticScore > 0 ? semanticScore * 0.7 + keywordScore * 0.3 : keywordScore;
    return { chunk, score: combinedScore };
  });

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

  // Only cite chunks that actually cleared the relevance bar. Falling back to
  // the top-2 regardless produced confident-looking citations for answers that
  // were not grounded in them at all.
  const sources: SourceCitation[] = matchedChunks.map((r) => ({
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
  // The caller stores the incoming question before calling us, so drop any
  // trailing copy of it — otherwise the prompt asks the same thing twice.
  const lastMsg = history[history.length - 1];
  const priorHistory =
    lastMsg && lastMsg.role === "user" && lastMsg.content.trim() === userPrompt.trim()
      ? history.slice(0, -1)
      : history;
  const recentHistory = priorHistory.slice(-6).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");

  const prompt = `Here is the relevant excerpt from the user's uploaded PDFs:
=== BEGIN CONTEXT ===
${contextText || "(No matching content found for this query in the indexed PDFs)"}
=== END CONTEXT ===

${recentHistory ? `Recent Conversation History:\n${recentHistory}\n` : ""}
User's Question: "${userPrompt}"

Please answer the question thoroughly and accurately based on the context above. Always mention the relevant document name(s) and page number(s). If the context doesn't contain the answer, state that clearly.`;

  const ai = getGeminiClient();
  // "gemini-2.5-flash" is no longer served to newly created API keys, which
  // made every request fall through to the generic failure message. Lead with
  // a current model and keep the floating aliases as backstops.
  const candidateModels = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];

  let answerText = "";
  let lastError = "";
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
        lastError = errMsg;
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
    // Surface the real reason rather than a blanket "temporary issue" — a
    // missing API key or a retired model is not something retrying will fix.
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        "GEMINI_API_KEY is not set on the server, so no answer could be generated. Add it to your .env file and restart the server."
      );
    }
    throw new Error(
      `The AI service could not generate an answer${lastError ? `: ${lastError.slice(0, 300)}` : "."}`
    );
  }

  // When the model reports that the documents do not cover the question, the
  // retrieved chunks are not citations for anything — attaching them showed
  // "6 Sources cited" underneath an "I could not find this" answer.
  const declinedToAnswer = /could not find|couldn't find|couldn.t find|not (?:mentioned|contained|present|found) in the (?:uploaded |provided )?(?:pdf|document)/i.test(
    answerText
  );

  return {
    answer: answerText,
    sources: declinedToAnswer ? [] : sources,
  };
}
