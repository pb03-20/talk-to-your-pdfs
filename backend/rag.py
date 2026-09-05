"""
RAG and Document Processing Module using PyMuPDF (fitz) and Google Gemini API.

Upgrades over a naive "chunk + top-k cosine similarity" RAG:

1. Paragraph-aware chunking (splits on real paragraph/sentence boundaries instead
   of a blind character window), so each chunk is a coherent unit of meaning.
2. Hybrid retrieval: BM25 (exact keyword/number matches — names, dates, codes,
   section numbers) fused with dense embedding similarity via Reciprocal Rank
   Fusion (RRF). Embeddings alone routinely miss exact-term queries; BM25 alone
   misses paraphrases. Together they cover both.
3. MMR (Maximal Marginal Relevance) re-ranking so the final context isn't 5
   near-duplicate chunks from the same paragraph.
4. Per-document abstractive summaries generated once at upload time (map-reduce
   over chunks), used to answer "what is this document about" / cross-cutting
   questions that no single chunk can answer.
5. Embedding dimension safety: the hash fallback is tagged so it is never mixed
   with real Gemini embeddings in the same similarity comparison (which would
   silently produce meaningless scores).

pip install: pymupdf numpy google-genai rank-bm25
"""

import os
import re
import math
from typing import List, Dict, Any, Tuple, Optional

import fitz  # PyMuPDF
import numpy as np
from google import genai
from google.genai import types

try:
    from rank_bm25 import BM25Okapi
except ImportError:  # pragma: no cover
    BM25Okapi = None

EMBEDDING_MODEL = "gemini-embedding-2-preview"
EMBEDDING_FALLBACK_MODEL = "text-embedding-004"
GENERATION_MODEL = "gemini-2.5-flash"
# A long-context model lets us skip retrieval entirely for documents that fit,
# giving genuinely complete knowledge of the book instead of the top-k
# approximation RAG provides. Verify this model string against Google's
# current Gemini docs — long-context model names/limits change.
LONG_CONTEXT_MODEL = "gemini-2.5-pro"
LONG_CONTEXT_TOKEN_BUDGET = 800_000  # stay well under the model's max context
                                      # to leave room for the prompt + answer
                                      # and avoid the quality drop-off some
                                      # long-context models show near their limit.
FALLBACK_DIM = 384  # dim used ONLY by the local hash fallback, kept distinct
                     # on purpose so it can never be silently compared against
                     # a real embedding of a different dimensionality.


def get_gemini_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    return genai.Client(api_key=api_key)


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

class PDFExtractionError(Exception):
    """Raised when a PDF truly can't be read (corrupted beyond repair, or
    encrypted with a password we don't have) — lets the API layer report a
    clean error for that one file instead of crashing the whole upload."""


def _order_blocks_for_reading(blocks: List[Tuple], page_width: float) -> List[Tuple]:
    """
    PyMuPDF's plain get_text('text') reads blocks in the order they appear
    in the PDF's internal structure, which for multi-column layouts (papers,
    magazines, two-column book pages) often interleaves columns line-by-line
    and produces scrambled text. This clusters blocks into left/right columns
    by x-position and reorders them column-by-column, top-to-bottom — a
    simple but effective fix for the common 1-2 column case.
    """
    if not blocks:
        return blocks
    midpoint = page_width / 2
    left_col = sorted([b for b in blocks if b[0] < midpoint], key=lambda b: b[1])
    right_col = sorted([b for b in blocks if b[0] >= midpoint], key=lambda b: b[1])
    # If nearly everything is on one side, it's single-column — don't split.
    if not left_col or not right_col or min(len(left_col), len(right_col)) < 2:
        return sorted(blocks, key=lambda b: b[1])
    return left_col + right_col


def _ocr_page(page: "fitz.Page") -> str:
    """
    OCRs a page that has no extractable text layer (scanned image PDFs).
    Requires: pip install pytesseract pillow, and the tesseract binary
    installed on the host (apt-get install tesseract-ocr). Fails soft —
    returns "" if OCR isn't available, so the pipeline still works without it,
    just without text for image-only pages.
    """
    try:
        import pytesseract
        from PIL import Image
        import io as _io

        pix = page.get_pixmap(dpi=200)
        img = Image.open(_io.BytesIO(pix.tobytes("png")))
        return pytesseract.image_to_string(img).strip()
    except Exception:
        return ""


def extract_pdf_pages_pymupdf(
    file_bytes: bytes,
    password: Optional[str] = None,
    ocr_scanned_pages: bool = True,
) -> Tuple[int, List[Dict[str, Any]]]:
    """
    Extracts text page-by-page using PyMuPDF, robust to:
      - Encrypted PDFs (tries the given password, then an empty password —
        many "protected" PDFs are just owner-locked with no real password).
      - Corrupted/malformed PDFs (raises PDFExtractionError with a clear
        message instead of an opaque fitz exception).
      - Multi-column layouts (reorders text blocks column-by-column instead
        of trusting raw internal order).
      - Scanned/image-only pages (falls back to OCR when there's no text
        layer, if pytesseract is installed).

    Returns total_pages and a list of
    { 'page_number', 'text', 'is_empty', 'was_ocr' }.
    """
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
    except Exception as e:
        raise PDFExtractionError(f"Could not open PDF (file may be corrupted): {e}")

    if doc.is_encrypted:
        if not doc.authenticate(password or ""):
            doc.close()
            raise PDFExtractionError(
                "This PDF is password-protected and the provided password didn't work."
            )

    pages = []
    total_pages = len(doc)

    for i in range(total_pages):
        page = doc.load_page(i)
        was_ocr = False
        try:
            blocks = page.get_text("blocks")
            ordered = _order_blocks_for_reading(blocks, page.rect.width)
            text = "\n".join(b[4].strip() for b in ordered if b[4].strip())
        except Exception:
            text = page.get_text("text").strip()

        is_empty = len(text) < 10
        if is_empty and ocr_scanned_pages:
            ocr_text = _ocr_page(page)
            if ocr_text:
                text = ocr_text
                was_ocr = True
                is_empty = len(text) < 10

        pages.append({
            "page_number": i + 1,
            "text": text,
            "is_empty": is_empty,  # still true if OCR unavailable/failed too
            "was_ocr": was_ocr,
        })

    doc.close()
    return total_pages, pages


# --------------------------------------------------------------------------
# Chunking — paragraph/sentence aware, not blind character windows

# --------------------------------------------------------------------------

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")


def _split_into_sentences(paragraph: str) -> List[str]:
    sentences = _SENTENCE_SPLIT_RE.split(paragraph.strip())
    return [s.strip() for s in sentences if s.strip()]


def _approx_token_count(text: str) -> int:
    # Cheap approximation (~4 chars/token for English) — good enough for
    # sizing chunks without pulling in a tokenizer dependency.
    return max(1, len(text) // 4)


def chunk_pages(
    workspace_id: str,
    doc_id: str,
    filename: str,
    pages: List[Dict[str, Any]],
    target_tokens: int = 350,
    overlap_sentences: int = 2,
) -> List[Dict[str, Any]]:
    """
    Splits page text into chunks along paragraph -> sentence boundaries,
    packing sentences into a chunk until it reaches ~target_tokens, then
    carrying the last `overlap_sentences` sentences into the next chunk so
    context isn't lost across the boundary.
    """
    chunks = []
    chunk_counter = 0

    for page in pages:
        text = page["text"]
        if not text or page.get("is_empty"):
            continue

        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        # Fall back to treating the whole page as one paragraph if the PDF
        # doesn't use blank-line paragraph breaks.
        if len(paragraphs) <= 1:
            paragraphs = [text]

        sentences: List[str] = []
        for p in paragraphs:
            sentences.extend(_split_into_sentences(p))
            sentences.append("")  # paragraph boundary marker (blank = break)

        current: List[str] = []
        current_tokens = 0

        def flush():
            nonlocal current, current_tokens, chunk_counter
            joined = " ".join(s for s in current if s).strip()
            if len(joined) > 30:
                chunk_counter += 1
                chunks.append({
                    "id": f"{doc_id}_chunk_{chunk_counter}",
                    "workspace_id": workspace_id,
                    "doc_id": doc_id,
                    "filename": filename,
                    "page_number": page["page_number"],
                    "chunk_index": chunk_counter,
                    "text": joined,
                    "embedding": None,
                    "embedding_kind": None,  # "gemini" | "hash"
                })

        for sent in sentences:
            if sent == "":
                continue
            sent_tokens = _approx_token_count(sent)
            if current_tokens + sent_tokens > target_tokens and current:
                flush()
                current = current[-overlap_sentences:] if overlap_sentences else []
                current_tokens = sum(_approx_token_count(s) for s in current)
            current.append(sent)
            current_tokens += sent_tokens

        if current:
            flush()

    return chunks


# --------------------------------------------------------------------------
# Embeddings
# --------------------------------------------------------------------------

def embed_text_gemini(text: str) -> Tuple[List[float], str]:
    """
    Generates embeddings using Gemini, with a same-provider fallback model,
    and only as a last resort a local hash vector.

    Returns (vector, kind) where kind is "gemini" or "hash". Callers MUST
    check `kind` before comparing vectors — a "hash" vector is only
    comparable to other "hash" vectors, never to a real embedding.
    """
    client = get_gemini_client()
    try:
        res = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text[:8000],
        )
        if getattr(res, "embeddings", None):
            return res.embeddings[0].values, "gemini"
    except Exception:
        pass

    try:
        res = client.models.embed_content(
            model=EMBEDDING_FALLBACK_MODEL,
            contents=text[:8000],
        )
        if getattr(res, "embeddings", None):
            return res.embeddings[0].values, "gemini"
    except Exception:
        pass

    # Local hash fallback — deliberately low quality but keeps the app
    # functional if the embedding API is down. Tagged as "hash" so it never
    # gets silently mixed with real embeddings during retrieval.
    vec = np.zeros(FALLBACK_DIM, dtype=np.float32)
    for i, w in enumerate(text.lower().split()):
        h = abs(hash(w)) % FALLBACK_DIM
        vec[h] += 1.0 / (i + 1)
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec.tolist(), "hash"


def embed_texts_batch(texts: List[str]) -> List[Tuple[List[float], str]]:
    """Embeds a list of texts. Uses the SDK's batch call when possible and
    falls back to one-by-one on failure, so a single bad chunk can't sink
    the whole document's embedding pass."""
    if not texts:
        return []
    client = get_gemini_client()
    try:
        res = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=[t[:8000] for t in texts],
        )
        if getattr(res, "embeddings", None) and len(res.embeddings) == len(texts):
            return [(e.values, "gemini") for e in res.embeddings]
    except Exception:
        pass
    return [embed_text_gemini(t) for t in texts]


def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    a = np.array(v1, dtype=np.float32)
    b = np.array(v2, dtype=np.float32)
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


# --------------------------------------------------------------------------
# BM25 keyword index (per workspace) — catches exact terms embeddings blur
# --------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> List[str]:
    return _TOKEN_RE.findall(text.lower())


class WorkspaceBM25Index:
    """Thin wrapper so main.py can rebuild/query BM25 without caring about
    the underlying library."""

    def __init__(self, chunks: List[Dict[str, Any]]):
        self.chunks = chunks
        self._bm25 = None
        if BM25Okapi and chunks:
            self._bm25 = BM25Okapi([_tokenize(c["text"]) for c in chunks])

    def top_n(self, query: str, n: int) -> List[Tuple[Dict[str, Any], float]]:
        if not self._bm25 or not self.chunks:
            return []
        scores = self._bm25.get_scores(_tokenize(query))
        ranked = sorted(zip(self.chunks, scores), key=lambda x: x[1], reverse=True)
        return [(c, s) for c, s in ranked[:n] if s > 0]


# --------------------------------------------------------------------------
# Query expansion — fixes vocabulary mismatch (e.g. user says "recommends
# music", the book says "curates personalized playlists"). Embeddings and
# BM25 both work off the query's literal wording; if the document never uses
# the user's words, retrieval can miss a chunk that plainly answers the
# question. Generating paraphrases and retrieving for all of them closes
# that gap without needing a bigger candidate pool.
# --------------------------------------------------------------------------

def generate_query_variations(query: str, n: int = 3) -> List[str]:
    """
    Asks Gemini for a few alternate phrasings/synonyms of the query so
    retrieval isn't limited to the user's exact word choice. Falls back to
    just the original query if generation fails — never blocks retrieval.
    """
    client = get_gemini_client()
    try:
        res = client.models.generate_content(
            model=GENERATION_MODEL,
            contents=(
                f"Give {n} alternate ways to ask this question, using different "
                f"synonyms and phrasing a textbook or business book might use "
                f"instead of the original wording. One per line, no numbering, "
                f"no extra commentary.\n\nQuestion: {query}"
            ),
            config=types.GenerateContentConfig(temperature=0.4),
        )
        lines = [l.strip("-• \t") for l in (res.text or "").splitlines() if l.strip()]
        variations = [l for l in lines if l][:n]
        return [query] + variations if variations else [query]
    except Exception:
        return [query]


# --------------------------------------------------------------------------
# Fusion + diversity re-ranking
# --------------------------------------------------------------------------

def reciprocal_rank_fusion(
    ranked_lists: List[List[Dict[str, Any]]],
    k: int = 60,
) -> List[Tuple[Dict[str, Any], float]]:
    """
    Combines multiple ranked lists of chunks (e.g. BM25 results, embedding
    results) into a single ranking using RRF: score = sum(1 / (k + rank)).
    This is the standard way to merge lexical and semantic search without
    needing scores on the same scale.
    """
    scores: Dict[str, float] = {}
    chunk_by_id: Dict[str, Dict[str, Any]] = {}
    for ranked in ranked_lists:
        for rank, chunk in enumerate(ranked):
            cid = chunk["id"]
            chunk_by_id[cid] = chunk
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
    fused = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [(chunk_by_id[cid], score) for cid, score in fused]


def mmr_select(
    query_embedding: List[float],
    candidates: List[Dict[str, Any]],
    top_k: int = 8,
    lambda_mult: float = 0.7,
    max_per_doc: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Maximal Marginal Relevance: greedily picks chunks that are relevant to
    the query AND dissimilar to chunks already picked, so the final context
    covers more of the document instead of 8 copies of the same paragraph.
    Chunks with a "hash"-kind embedding (dimension mismatch with the query
    embedding) are skipped for the similarity term and just kept in
    relevance order.

    max_per_doc caps how many chunks any single document can contribute —
    this matters once a workspace holds many PDFs: without it, one long or
    highly-relevant document can fill the entire context window and starve
    every other document out of the answer, even when the question concerns
    several of them.
    """
    if not candidates:
        return []

    usable = [c for c in candidates if c.get("embedding_kind") == "gemini"]
    unusable = [c for c in candidates if c.get("embedding_kind") != "gemini"]

    selected: List[Dict[str, Any]] = []
    doc_counts: Dict[str, int] = {}
    pool = usable.copy()

    while pool and len(selected) < top_k:
        best, best_score = None, -1e9
        for c in pool:
            if max_per_doc and doc_counts.get(c["doc_id"], 0) >= max_per_doc:
                continue
            relevance = cosine_similarity(query_embedding, c["embedding"])
            diversity_penalty = max(
                (cosine_similarity(c["embedding"], s["embedding"]) for s in selected),
                default=0.0,
            )
            mmr_score = lambda_mult * relevance - (1 - lambda_mult) * diversity_penalty
            if mmr_score > best_score:
                best, best_score = c, mmr_score
        if best is None:
            # Every remaining candidate hit its per-document cap.
            break
        selected.append(best)
        doc_counts[best["doc_id"]] = doc_counts.get(best["doc_id"], 0) + 1
        pool.remove(best)

    remaining_slots = top_k - len(selected)
    if remaining_slots > 0:
        selected.extend(unusable[:remaining_slots])

    return selected


def hybrid_retrieve(
    query: str,
    chunks: List[Dict[str, Any]],
    bm25_index: Optional[WorkspaceBM25Index],
    top_k: int = 8,
    candidate_pool: Optional[int] = None,
    use_query_expansion: bool = True,
    max_per_doc: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Full retrieval pipeline:
      1. Expand the query into a few paraphrases (vocabulary mismatch fix).
      2. For each phrasing, get BM25 candidates + embedding candidates.
      3. RRF-fuse everything into one ranking.
      4. MMR diversity re-rank down to top_k chunks, capped per document so
         a workspace with many PDFs doesn't have its answer dominated by
         whichever single document is largest or most superficially similar.

    candidate_pool and max_per_doc auto-scale with how many distinct
    documents are in the workspace when not given explicitly — a single-PDF
    workspace and a 30-PDF workspace need very different search widths.
    """
    if not chunks:
        return []

    num_docs = len({c["doc_id"] for c in chunks})
    if candidate_pool is None:
        candidate_pool = max(25, min(200, num_docs * 8))
    if max_per_doc is None:
        # Leave room for at least 2-3 distinct documents to contribute when
        # there are several in play; no cap for a single-document workspace.
        max_per_doc = top_k if num_docs <= 1 else max(2, top_k // min(num_docs, 4))

    queries = generate_query_variations(query) if use_query_expansion else [query]

    ranked_lists: List[List[Dict[str, Any]]] = []
    primary_embedding, primary_kind = None, None

    for i, q in enumerate(queries):
        q_embedding, q_kind = embed_text_gemini(q)
        if i == 0:
            primary_embedding, primary_kind = q_embedding, q_kind

        embedding_ranked = sorted(
            chunks,
            key=lambda c: cosine_similarity(q_embedding, c["embedding"])
            if q_kind == c.get("embedding_kind") else 0.0,
            reverse=True,
        )[:candidate_pool]
        ranked_lists.append(embedding_ranked)

        if bm25_index:
            ranked_lists.append([c for c, _ in bm25_index.top_n(q, candidate_pool)])

    fused = reciprocal_rank_fusion(ranked_lists)
    fused_chunks = [c for c, _ in fused][:candidate_pool]

    if primary_kind == "gemini":
        return mmr_select(primary_embedding, fused_chunks, top_k=top_k, max_per_doc=max_per_doc)
    return fused_chunks[:top_k]


# --------------------------------------------------------------------------
# Full-document context mode — genuine "knows everything" for documents that
# fit in the model's context window, instead of an approximation via
# retrieval. RAG's top-k is always a bet that the right passage got
# retrieved; skipping retrieval and handing the model the whole book removes
# that bet entirely. Falls back to hybrid_retrieve for documents too large
# to fit (a full book series, a huge manual) where this isn't possible.
# --------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)  # ~4 chars/token approximation


def build_full_document_context(documents_chunks: Dict[str, List[Dict[str, Any]]]) -> str:
    """
    Reconstructs each document's full text (in original page order) from its
    chunks, tagged with filename/page markers so the model can still cite
    them precisely even though it's reading the whole book, not snippets.
    `documents_chunks` maps filename -> that document's chunk list.
    """
    parts = []
    for filename, chunks in documents_chunks.items():
        ordered = sorted(chunks, key=lambda c: (c["page_number"], c["chunk_index"]))
        pages: Dict[int, List[str]] = {}
        for c in ordered:
            pages.setdefault(c["page_number"], []).append(c["text"])
        doc_text = "\n\n".join(
            f"[{filename} — Page {p}]\n" + " ".join(texts)
            for p, texts in sorted(pages.items())
        )
        parts.append(doc_text)
    return "\n\n=====\n\n".join(parts)


def fits_full_context(documents_chunks: Dict[str, List[Dict[str, Any]]]) -> bool:
    full_text = build_full_document_context(documents_chunks)
    return estimate_tokens(full_text) <= LONG_CONTEXT_TOKEN_BUDGET


# --------------------------------------------------------------------------
# Document-level summary — answers "what is this document about" style
# questions that no single chunk can, and gives the model a map of the doc.
# --------------------------------------------------------------------------

def summarize_document(filename: str, chunks: List[Dict[str, Any]], max_chunks_per_pass: int = 12) -> str:
    """
    Map-reduce summarization: summarizes the document in batches of chunks,
    then summarizes the summaries, so long PDFs still get a coherent
    document-level overview instead of only page-level snippets.
    """
    if not chunks:
        return ""
    client = get_gemini_client()
    ordered = sorted(chunks, key=lambda c: (c["page_number"], c["chunk_index"]))

    batch_summaries = []
    for i in range(0, len(ordered), max_chunks_per_pass):
        batch = ordered[i:i + max_chunks_per_pass]
        text_block = "\n\n".join(
            f"[p.{c['page_number']}] {c['text']}" for c in batch
        )
        try:
            res = client.models.generate_content(
                model=GENERATION_MODEL,
                contents=f"Summarize the key points of this excerpt from '{filename}' "
                         f"in 4-6 bullet points, preserving any page-specific facts:\n\n{text_block}",
                config=types.GenerateContentConfig(temperature=0.1),
            )
            batch_summaries.append(res.text or "")
        except Exception:
            continue

    if not batch_summaries:
        return ""
    if len(batch_summaries) == 1:
        return batch_summaries[0]

    try:
        res = client.models.generate_content(
            model=GENERATION_MODEL,
            contents="Combine these section summaries of the same document into one coherent "
                     "overview (8-10 bullet points, no repetition):\n\n" + "\n\n".join(batch_summaries),
            config=types.GenerateContentConfig(temperature=0.1),
        )
        return res.text or "\n\n".join(batch_summaries)
    except Exception:
        return "\n\n".join(batch_summaries)


_OVERVIEW_PATTERNS = re.compile(
    r"\b(summar|overview|about this document|main (points|topics|idea)|"
    r"what is this (pdf|document|file)|tl;?dr|key takeaways)\b",
    re.IGNORECASE,
)


def looks_like_overview_query(query: str) -> bool:
    return bool(_OVERVIEW_PATTERNS.search(query))


# --------------------------------------------------------------------------
# Response tone & format — let the user's own phrasing decide formatting
# instead of the model defaulting to bullet points for everything.
# --------------------------------------------------------------------------

TEACHER_PERSONA_PROMPT = (
    "You are a patient, encouraging teacher who knows these documents deeply. "
    "Explain things the way a good tutor would in a one-on-one session: warm, "
    "clear, and genuinely engaged with helping the person understand — not a "
    "search engine reading back snippets. Build on what the person already "
    "seems to know from their question. Use a concrete example or analogy "
    "from the material when it helps a concept click. If a topic naturally "
    "has more depth, offer to go further rather than dumping everything at "
    "once ('That's the core idea — want me to go into how X works in more "
    "detail?'). Keep the warmth even when the answer is 'this isn't covered "
    "in the documents.'"
)

_BULLET_PATTERN = re.compile(r"\b(bullet|list it|as a list|point[s]? form|itemi[sz]e)\b", re.IGNORECASE)
_STEPS_PATTERN = re.compile(r"\b(step[- ]by[- ]step|steps to|how do i|walk me through|instructions)\b", re.IGNORECASE)
_TABLE_PATTERN = re.compile(r"\b(table|compare|comparison|side by side|vs\.?|versus)\b", re.IGNORECASE)
_SHORT_PATTERN = re.compile(r"\b(short|brief|quick(ly)?|tl;?dr|one sentence|in a nutshell|concise(ly)?)\b", re.IGNORECASE)
_DETAILED_PATTERN = re.compile(r"\b(detail(ed)?|in depth|deep dive|thoroughly|explain (fully|everything)|comprehensive)\b", re.IGNORECASE)


def build_format_instruction(query: str) -> str:
    """
    Reads the user's literal phrasing for formatting intent and returns an
    explicit instruction for it. When nothing is signaled, the default is
    plain conversational prose — bullets/headers are the exception the user
    has to ask for, not the model's default output shape.
    """
    q = query.lower()
    instructions = []

    if _BULLET_PATTERN.search(q):
        instructions.append("Format the answer as a bulleted list.")
    elif _STEPS_PATTERN.search(q):
        instructions.append("Format the answer as clearly numbered steps.")
    elif _TABLE_PATTERN.search(q):
        instructions.append("Format the comparison as a markdown table.")

    if _SHORT_PATTERN.search(q):
        instructions.append("Keep the whole answer to 2-3 sentences — the person wants brevity.")
    elif _DETAILED_PATTERN.search(q):
        instructions.append("Go deep — the person explicitly wants a thorough, detailed explanation.")

    if not instructions:
        return (
            "No format was requested — respond in natural, flowing prose like you're "
            "talking the person through it, the way a teacher explains something out "
            "loud. Only reach for bullet points, numbered steps, or headers if the "
            "content is genuinely a list, sequence, or comparison where prose would "
            "be harder to follow than structure — not as a default habit."
        )
    return " ".join(instructions)