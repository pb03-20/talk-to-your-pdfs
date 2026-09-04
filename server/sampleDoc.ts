export const SAMPLE_DOCUMENT = {
  filename: "Gemini_Multimodal_and_RAG_Architecture.pdf",
  totalPages: 3,
  pages: [
    {
      pageNumber: 1,
      text: `EXECUTIVE SUMMARY & SYSTEM ARCHITECTURE
Title: Next-Generation Multimodal AI and Document Retrieval Architectures
Document ID: TECH-REF-2026-V3
Published: September 2026

Section 1: Introduction to Retrieval-Augmented Generation (RAG)
Retrieval-Augmented Generation (RAG) is an architectural framework that enhances Large Language Models (LLMs) by grounding generation in verified external document corpora. Traditional LLMs operate strictly over parameterized memory acquired during training, which can lead to hallucinations or stale factual assertions.

Section 2: High-Density Document Extraction
Accurate parsing of Portable Document Format (PDF) files requires preserving semantic structure across boundaries:
1. Spatial coordinate mapping: Text boxes and table columns must be reconstituted based on reading order coordinates.
2. Page-level provenance: Chunks must retain persistent metadata indicating their source page and offset.
3. Overlapping chunk boundaries: A standard chunk window of 600 to 800 characters with a 100-character stride prevents boundary truncations where critical clauses bridge across chunks.

Table 1.1: Benchmark Chunking Parameters
- Precision Metric: 94.2% retrieval accuracy with 700-character windows.
- Stride Overlap: 15% overlap minimizes context fragmentation across paragraph breaks.`,
    },
    {
      pageNumber: 2,
      text: `Section 3: Vector Embeddings & Similarity Metrics
Embedding models project arbitrary textual sequences into dense continuous metric spaces. In modern Gemini architectures, gemini-embedding-2-preview generates 3072-dimensional normalized vectors.

Section 3.1: Cosine Similarity Metric
The cosine similarity S(A, B) between a query vector A and document chunk vector B is defined mathematically as:
S(A, B) = (A · B) / (||A|| * ||B||)

When vectors are L2-normalized, this collapses directly to the dot product, enabling sub-millisecond similarity scans over thousands of document segments.

Section 3.2: Hybrid Search Implementation
Pure dense retrieval can occasionally overlook exact alphanumeric strings, such as product serials, specific version numbers, or legal citations. A hybrid index combines:
1. Dense semantic vector score (weight: 0.70)
2. Sparse keyword lexical overlap score (weight: 0.30)
This hybrid approach yields an empirical 22% reduction in retrieval misses.

Section 4: Anti-Hallucination Guardrails
To enforce factual grounding:
- The system prompt instructs the model to refuse speculative extrapolation.
- If the maximum chunk relevance score falls below the confidence threshold (theta = 0.20), the system returns an explicit fallback: "I could not find information about this in the uploaded PDFs."`,
    },
    {
      pageNumber: 3,
      text: `Section 5: Gemini Live Voice Protocol & Real-Time Audio Streaming
Real-time conversational voice interaction relies on the Gemini Live API (gemini-3.1-flash-live-preview). 

Section 5.1: Audio Streaming Specifications
- Input Audio Format: 16-bit linear PCM at 16,000 Hz (16 kHz), mono channel.
- Model Spoken Output Audio: 16-bit linear PCM at 24,000 Hz (24 kHz), little-endian encoding.
- Latency Profile: End-to-end speech turnaround averages 320ms to 450ms over persistent WebSockets.

Section 5.2: Bidirectional Transcription
During voice sessions, the server streams real-time transcripts:
1. Input Audio Transcription: Speech-to-text decoding of user utterances.
2. Output Audio Transcription: Synchronized text tokens corresponding to the generated synthesized speech.
This allows the user interface to simultaneously display a living transcript while playing back lifelike spoken audio through Web Audio API AudioContext nodes.

Section 6: Multi-Tenant Workspace Isolation
Each anonymous session is assigned an ephemeral workspace identifier (e.g. UUIDv4). Vector indices, document stores, and conversation histories are strictly partitioned by this identifier. No visitor has access to or can cross-query documents uploaded by another user.`,
    },
  ],
};
