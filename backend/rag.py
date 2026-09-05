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
import time
import math
from typing import List, Dict, Any, Tuple, Optional
from dotenv import load_dotenv
from pymongo import MongoClient, ASCENDING

load_dotenv()
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import fitz  # PyMuPDF
import numpy as np
from google import genai
from google.genai import types

try:
    from rank_bm25 import BM25Okapi
except ImportError:  # pragma: no cover
    BM25Okapi = None

EMBEDDING_MODEL = "gemini-embedding-2-preview"
EMBEDDING_FALLBACK_MODEL = "gemini-embedding-001"
GENERATION_MODEL = "gemini-3.6-flash"
LONG_CONTEXT_MODEL = "gemini-3.6-flash"
LONG_CONTEXT_TOKEN_BUDGET = 25_000  # 25k tokens (~25-30 pages) max for full-context bypass;
                                    # larger corpora automatically use Hybrid Retrieval (BM25 + embeddings)
                                    # to stay safely below the 250k free tier tokens/min quota.
FALLBACK_DIM = 384  # dim used ONLY by the local hash fallback, kept distinct
# --------------------------------------------------------------------------
# MongoDB Vector Store
# --------------------------------------------------------------------------
# Required environment variables:
#   MONGODB_URI=mongodb+srv://...
#   MONGODB_DATABASE=your_database
#   MONGODB_VECTOR_COLLECTION=document_chunks
#
# The collection stores:
#   - the chunk text and document metadata
#   - the Gemini embedding
#   - an Atlas Vector Search index can search the "embedding" field
#
# Create an Atlas Vector Search index named "vector_index" on the collection
# with the "embedding" field configured as the vector field. The dimensions
# must match the Gemini embedding model's output dimensions.

MONGODB_URI = os.environ.get("MONGODB_URI", "")
MONGODB_DATABASE = os.environ.get("MONGODB_DATABASE", "rag_database")
MONGODB_VECTOR_COLLECTION = os.environ.get(
    "MONGODB_VECTOR_COLLECTION", "document_chunks"
)
MONGODB_VECTOR_INDEX = os.environ.get("MONGODB_VECTOR_INDEX", "vector_index")

_mongo_client: Optional[MongoClient] = None


def mongodb_enabled() -> bool:
    """Return whether MongoDB persistence has been configured."""
    return bool(MONGODB_URI)


def get_mongo_client() -> MongoClient:
    """Return a cached MongoDB client."""
    global _mongo_client

    if not MONGODB_URI:
        raise RuntimeError(
            "MONGODB_URI is not set. Add your MongoDB connection string to .env."
        )

    if _mongo_client is None:
        _mongo_client = MongoClient(
            MONGODB_URI,
            serverSelectionTimeoutMS=10000,
        )

    return _mongo_client


def get_mongo_collection():
    """Return the MongoDB collection used for vector storage."""
    client = get_mongo_client()
    db = client[MONGODB_DATABASE]
    collection = db[MONGODB_VECTOR_COLLECTION]

    # Normal indexes for filtering/deleting documents.
    collection.create_index(
        [("workspace_id", ASCENDING), ("doc_id", ASCENDING)]
    )
    collection.create_index([("workspace_id", ASCENDING)])

    return collection


def save_chunks_to_mongodb(
    chunks: List[Dict[str, Any]],
    generate_embeddings: bool = True,
) -> int:
    """
    Persist document chunks and their Gemini embeddings in MongoDB.

    Each MongoDB document contains:
      _id, id, workspace_id, doc_id, filename, page_number,
      chunk_index, text, embedding, embedding_kind.

    Existing chunks with the same `id` are updated rather than duplicated.

    Returns the number of chunks written.
    """
    if not chunks:
        return 0

    collection = get_mongo_collection()

    if generate_embeddings:
        texts = [c["text"] for c in chunks]
        embedding_results = embed_texts_batch(texts)

        for chunk, (embedding, embedding_kind) in zip(
            chunks, embedding_results
        ):
            chunk["embedding"] = embedding
            chunk["embedding_kind"] = embedding_kind

    operations = []

    for chunk in chunks:
        embedding = chunk.get("embedding")
        embedding_kind = chunk.get("embedding_kind")

        document = {
            "_id": chunk["id"],
            "id": chunk["id"],
            "workspace_id": str(chunk["workspace_id"]),
            "doc_id": str(chunk["doc_id"]),
            "filename": chunk["filename"],
            "page_number": int(chunk["page_number"]),
            "chunk_index": int(chunk["chunk_index"]),
            "text": chunk["text"],
            "embedding_kind": embedding_kind,
        }

        # Keep chunks even when Gemini embedding generation falls back. Atlas
        # simply excludes documents without the indexed vector field, while
        # the text and metadata remain durable and available to BM25/local
        # retrieval. Storing a hash vector here would corrupt a Gemini vector
        # index because it has a different meaning and possibly dimensions.
        if embedding and embedding_kind == "gemini":
            document["embedding"] = embedding

        operations.append({
            "replace_one": {
                "filter": {"_id": chunk["id"]},
                "replacement": document,
                "upsert": True,
            }
        })

    if not operations:
        return 0

    from pymongo import ReplaceOne

    collection.bulk_write([
        ReplaceOne(
            operation["replace_one"]["filter"],
            operation["replace_one"]["replacement"],
            upsert=operation["replace_one"]["upsert"],
        )
        for operation in operations
    ])

    # A repeated upload may match documents whose values have not changed;
    # those are still successful writes/synchronizations.
    return len(operations)


def delete_document_chunks_from_mongodb(
    workspace_id: str,
    doc_id: str,
) -> int:
    """Delete all vector chunks belonging to one document."""
    collection = get_mongo_collection()

    result = collection.delete_many({
        "workspace_id": str(workspace_id),
        "doc_id": str(doc_id),
    })

    return result.deleted_count


def delete_workspace_chunks_from_mongodb(workspace_id: str) -> int:
    """Delete all vector chunks belonging to a workspace."""
    collection = get_mongo_collection()

    result = collection.delete_many({
        "workspace_id": str(workspace_id),
    })

    return result.deleted_count


def vector_search_mongodb(
    query: str,
    workspace_id: str,
    top_k: int = 12,
    num_candidates: int = 100,
    target_doc_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Search MongoDB Atlas Vector Search using a Gemini query embedding.

    Requires a MongoDB Atlas Vector Search index named by MONGODB_VECTOR_INDEX.
    The index must use:
        path: "embedding"
        similarity: "cosine"
    and the correct embedding dimensions for the selected Gemini model.
    """
    query_embedding, query_kind = embed_text_gemini(query)

    if query_kind != "gemini":
        return []

    collection = get_mongo_collection()

    vector_filter: Dict[str, Any] = {
        "workspace_id": str(workspace_id),
    }

    if target_doc_id:
        vector_filter["doc_id"] = str(target_doc_id)

    pipeline = [
        {
            "$vectorSearch": {
                "index": MONGODB_VECTOR_INDEX,
                "path": "embedding",
                "queryVector": query_embedding,
                "numCandidates": max(num_candidates, top_k),
                "limit": top_k,
                "filter": vector_filter,
            }
        },
        {
            "$project": {
                "_id": 0,
                "id": 1,
                "workspace_id": 1,
                "doc_id": 1,
                "filename": 1,
                "page_number": 1,
                "chunk_index": 1,
                "text": 1,
                "embedding": 1,
                "embedding_kind": 1,
                "vector_score": {"$meta": "vectorSearchScore"},
            }
        },
    ]

    try:
        return list(collection.aggregate(pipeline))
    except Exception as e:
        raise RuntimeError(
            "MongoDB Atlas Vector Search failed. Make sure the collection "
            f"'{MONGODB_VECTOR_COLLECTION}' has a Vector Search index named "
            f"'{MONGODB_VECTOR_INDEX}' on the 'embedding' field. "
            f"Original error: {e}"
        ) from e


def load_workspace_chunks_from_mongodb(
    workspace_id: str,
) -> List[Dict[str, Any]]:
    """Load all chunks for a workspace, useful for rebuilding BM25/MMR state."""
    collection = get_mongo_collection()

    return list(
        collection.find(
            {"workspace_id": str(workspace_id)},
            {
                "_id": 0,
                "id": 1,
                "workspace_id": 1,
                "doc_id": 1,
                "filename": 1,
                "page_number": 1,
                "chunk_index": 1,
                "text": 1,
                "embedding": 1,
                "embedding_kind": 1,
            },
        ).sort([
            ("filename", ASCENDING),
            ("page_number", ASCENDING),
            ("chunk_index", ASCENDING),
        ])
    )


def hybrid_retrieve_from_mongodb(
    query: str,
    workspace_id: str,
    top_k: int = 12,
    num_candidates: int = 100,
    target_doc_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    MongoDB-backed dense retrieval.

    This is useful when the application should not load the complete
    embedding corpus into RAM. It returns the same general chunk structure
    used by the existing RAG pipeline.
    """
    queries = generate_query_variations(query)

    merged: Dict[str, Dict[str, Any]] = {}

    for q in queries:
        results = vector_search_mongodb(
            q,
            workspace_id=workspace_id,
            top_k=top_k,
            num_candidates=num_candidates,
            target_doc_id=target_doc_id,
        )

        for rank, chunk in enumerate(results):
            chunk_id = chunk["id"]
            rrf_score = 1.0 / (60 + rank + 1)

            if chunk_id not in merged:
                merged[chunk_id] = dict(chunk)
                merged[chunk_id]["rrf_score"] = rrf_score
            else:
                merged[chunk_id]["rrf_score"] += rrf_score

    ranked = sorted(
        merged.values(),
        key=lambda c: c.get("rrf_score", 0.0),
        reverse=True,
    )

    # Keep the existing MMR implementation as the final diversity step.
    query_embedding, query_kind = embed_text_gemini(query)

    if query_kind == "gemini":
        return mmr_select(
            query_embedding,
            ranked,
            top_k=top_k,
            max_per_doc=None,
        )

    return ranked[:top_k]


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


_OCR_CHECKED = False
_OCR_AVAILABLE = False

def _check_ocr_available() -> bool:
    global _OCR_CHECKED, _OCR_AVAILABLE
    if not _OCR_CHECKED:
        _OCR_CHECKED = True
        try:
            import pytesseract
            from PIL import Image
            _OCR_AVAILABLE = True
        except ImportError:
            _OCR_AVAILABLE = False
    return _OCR_AVAILABLE


def _ocr_page(page: "fitz.Page") -> str:
    """
    OCRs a page that has no extractable text layer (scanned image PDFs).
    Fails soft — returns "" if OCR isn't available, so the pipeline still works without it.
    """
    if not _check_ocr_available():
        return ""
    try:
        import pytesseract
        from PIL import Image
        import io as _io

        pix = page.get_pixmap(dpi=150)
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
    contents = [types.Content(parts=[types.Part.from_text(text=text[:8000])])]
    try:
        res = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=contents,
        )
        if getattr(res, "embeddings", None) and res.embeddings:
            return res.embeddings[0].values, "gemini"
    except Exception:
        pass

    try:
        res = client.models.embed_content(
            model=EMBEDDING_FALLBACK_MODEL,
            contents=contents,
        )
        if getattr(res, "embeddings", None) and res.embeddings:
            return res.embeddings[0].values, "gemini"
    except Exception:
        pass

    # Local hash fallback — deliberately low quality but keeps the app
    # functional if the embedding API is down or quota is reached.
    vec = np.zeros(FALLBACK_DIM, dtype=np.float32)
    for i, w in enumerate(text.lower().split()):
        h = abs(hash(w)) % FALLBACK_DIM
        vec[h] += 1.0 / (i + 1)
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec.tolist(), "hash"


def embed_texts_batch(texts: List[str], batch_size: int = 25) -> List[Tuple[List[float], str]]:
    """Embeds a list of texts using batching (25 items per API call) with types.Content
    so the Gemini SDK embeds all items in a single request.
    If the API is down or rate limits are reached, seamlessly falls back to hash embeddings
    so file upload never hangs or times out."""
    if not texts:
        return []
    results: List[Tuple[List[float], str]] = []
    client = get_gemini_client()

    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        succeeded = False
        contents = [
            types.Content(parts=[types.Part.from_text(text=t[:4000])])
            for t in batch
        ]

        # Primary batch attempt
        try:
            res = client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=contents,
            )
            if getattr(res, "embeddings", None) and len(res.embeddings) == len(batch):
                results.extend([(e.values, "gemini") for e in res.embeddings])
                succeeded = True
        except Exception:
            pass

        # Fallback batch model attempt
        if not succeeded:
            try:
                res = client.models.embed_content(
                    model=EMBEDDING_FALLBACK_MODEL,
                    contents=contents,
                )
                if getattr(res, "embeddings", None) and len(res.embeddings) == len(batch):
                    results.extend([(e.values, "gemini") for e in res.embeddings])
                    succeeded = True
            except Exception:
                pass

        # Instant local hash fallback if API quota or connection failed
        if not succeeded:
            for t in batch:
                vec = np.zeros(FALLBACK_DIM, dtype=np.float32)
                for idx, w in enumerate(t.lower().split()):
                    h = abs(hash(w)) % FALLBACK_DIM
                    vec[h] += 1.0 / (idx + 1)
                norm = np.linalg.norm(vec)
                if norm > 0:
                    vec /= norm
                results.append((vec.tolist(), "hash"))

        # Brief polite delay between batches to stay comfortably within rate limits
        if i + batch_size < len(texts):
            time.sleep(0.08)

    return results


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


def detect_targeted_document(query: str, documents: List[Dict[str, Any]]) -> Optional[str]:
    """
    Detects if the user is asking about a specific book or document in the library.
    Checks for distinctive keywords from filenames.
    """
    if not documents or len(documents) <= 1:
        return None

    q_lower = query.lower()
    best_doc_id = None
    best_match_score = 0

    stop_words = {"the", "a", "an", "and", "or", "of", "in", "to", "for", "with", "on", "at", "by", "from", "pdf", "book", "author", "1lib", "z-lib", "sk", "edition"}

    for doc in documents:
        fname = doc.get("filename", "").lower()
        clean_name = re.sub(r"\.(pdf|epub|txt)$", "", fname)
        clean_name = re.sub(r"\(.*?\)", "", clean_name)
        words = [w for w in re.findall(r"[a-z0-9]{3,}", clean_name) if w not in stop_words]

        matches = sum(1 for w in words if w in q_lower)
        if matches >= 1 and matches > best_match_score:
            best_match_score = matches
            best_doc_id = doc["id"]

    return best_doc_id


def expand_neighbor_chunks(
    selected_chunks: List[Dict[str, Any]],
    all_chunks: List[Dict[str, Any]],
    max_total_chunks: int = 18,
) -> List[Dict[str, Any]]:
    """
    For retrieved chunks, stitches adjacent chunks from the same document
    so paragraphs, code, and thoughts are continuous and coherent.
    """
    if not selected_chunks or not all_chunks:
        return selected_chunks

    chunk_map = {(c["doc_id"], c["chunk_index"]): c for c in all_chunks}
    expanded_dict = {c["id"]: c for c in selected_chunks}

    for c in selected_chunks:
        if len(expanded_dict) >= max_total_chunks:
            break
        doc_id = c["doc_id"]
        c_idx = c["chunk_index"]
        next_chunk = chunk_map.get((doc_id, c_idx + 1))
        if next_chunk and next_chunk["id"] not in expanded_dict:
            expanded_dict[next_chunk["id"]] = next_chunk

    return sorted(expanded_dict.values(), key=lambda x: (x["filename"], x["page_number"], x["chunk_index"]))


def hybrid_retrieve(
    query: str,
    chunks: List[Dict[str, Any]],
    bm25_index: Optional[WorkspaceBM25Index],
    top_k: int = 12,
    candidate_pool: Optional[int] = None,
    use_query_expansion: bool = True,
    max_per_doc: Optional[int] = None,
    target_doc_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Full retrieval pipeline:
      1. Book-aware filtering if a specific book is targeted.
      2. Paraphrased query expansion for vocabulary coverage.
      3. BM25 keyword matching + dense Gemini embeddings.
      4. Reciprocal Rank Fusion (RRF).
      5. Maximal Marginal Relevance (MMR) re-ranking for diversity.
      6. Adjacent chunk expansion for continuous context.
    """
    if not chunks:
        return []

    search_chunks = chunks
    active_bm25 = bm25_index

    if target_doc_id:
        doc_specific_chunks = [c for c in chunks if c["doc_id"] == target_doc_id]
        if len(doc_specific_chunks) >= 3:
            search_chunks = doc_specific_chunks
            active_bm25 = WorkspaceBM25Index(search_chunks)

    num_docs = len({c["doc_id"] for c in search_chunks})
    if candidate_pool is None:
        candidate_pool = max(35, min(300, num_docs * 15))
    if max_per_doc is None:
        max_per_doc = top_k if num_docs <= 1 else max(3, top_k // min(num_docs, 3))

    queries = generate_query_variations(query) if use_query_expansion else [query]

    ranked_lists: List[List[Dict[str, Any]]] = []
    primary_embedding, primary_kind = None, None

    for i, q in enumerate(queries):
        q_embedding, q_kind = embed_text_gemini(q)
        if i == 0:
            primary_embedding, primary_kind = q_embedding, q_kind

        embedding_ranked = sorted(
            search_chunks,
            key=lambda c: cosine_similarity(q_embedding, c["embedding"])
            if q_kind == c.get("embedding_kind") else 0.0,
            reverse=True,
        )[:candidate_pool]
        ranked_lists.append(embedding_ranked)

        if active_bm25:
            ranked_lists.append([c for c, _ in active_bm25.top_n(q, candidate_pool)])

    fused = reciprocal_rank_fusion(ranked_lists)
    fused_chunks = [c for c, _ in fused][:candidate_pool]

    if primary_kind == "gemini":
        selected = mmr_select(primary_embedding, fused_chunks, top_k=top_k, max_per_doc=max_per_doc)
    else:
        selected = fused_chunks[:top_k]

    return expand_neighbor_chunks(selected, search_chunks, max_total_chunks=top_k + 4)


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

def summarize_document(filename: str, chunks: List[Dict[str, Any]]) -> str:
    """
    Fast abstractive summarization using representative chunk sampling.
    """
    if not chunks:
        return ""
    ordered = sorted(chunks, key=lambda c: (c["page_number"], c["chunk_index"]))
    if len(ordered) <= 8:
        sampled = ordered
    else:
        step = (len(ordered) - 1) / 7.0
        sampled = [ordered[int(i * step)] for i in range(8)]

    text_block = "\n\n".join(f"[Page {c['page_number']}] {c['text'][:400]}" for c in sampled)
    client = get_gemini_client()
    try:
        res = client.models.generate_content(
            model=GENERATION_MODEL,
            contents=f"Summarize the key points of '{filename}' in 4-6 bullet points based on these excerpts:\n\n{text_block}",
            config=types.GenerateContentConfig(temperature=0.1),
        )
        return res.text or ""
    except Exception:
        return ""


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
    "You are an author-level scholar and master tutor with deep knowledge of the uploaded books and documents.\n\n"
    "YOUR CORE TEACHING MISSION:\n"
    "When the user asks anything about the book(s), explain it with absolute conceptual clarity, "
    "depth, and structure. Never give shallow answers, vague teasers, or robotic snippets. "
    "Explain things the way an exceptional professor or senior engineer breaks down complex concepts "
    "so that anyone can grasp the intuition, the underlying mechanics, and the practical application.\n\n"
    "EXPLANATION GUIDELINES:\n"
    "1. Direct & Intuitive Lead: Immediately answer the core question in plain English with an intuitive overview.\n"
    "2. Comprehensive Breakdown: Break the topic down using clear Markdown headings (###), bolded terms, "
    "and bullet points or numbered steps. Cover the 'why', the 'how', and trade-offs/nuances.\n"
    "3. Real Examples & Analogies: Use concrete examples, code, formulas, or analogies directly from the text to make ideas click.\n"
    "4. Rigorous Grounding & Citations: Ground every assertion in the provided PDF text and always cite "
    "the exact document filename and page number: `[Filename — Page X]`.\n"
    "5. Follow Format Intent: Match the structure the user asked for (tables, numbered steps, deep dive, or summaries)."
)

_BULLET_PATTERN = re.compile(r"\b(bullet|list it|as a list|point[s]? form|itemi[sz]e)\b", re.IGNORECASE)
_STEPS_PATTERN = re.compile(r"\b(step[- ]by[- ]step|steps to|how do i|walk me through|instructions|process|procedure)\b", re.IGNORECASE)
_TABLE_PATTERN = re.compile(r"\b(table|compare|comparison|side by side|vs\.?|versus|matrix)\b", re.IGNORECASE)
_SHORT_PATTERN = re.compile(r"\b(short|brief|quick(ly)?|tl;?dr|one sentence|in a nutshell|concise(ly)?)\b", re.IGNORECASE)
_DETAILED_PATTERN = re.compile(r"\b(detail(ed)?|in depth|deep dive|thoroughly|explain (fully|everything)|comprehensive)\b", re.IGNORECASE)


def build_format_instruction(query: str) -> str:
    """
    Translates user phrasing and query intent into explicit formatting instructions
    so responses are structured, clean, and directly fit the user's need.
    """
    q = query.lower()
    instructions = []

    if _TABLE_PATTERN.search(q):
        instructions.append(
            "FORMAT REQUIREMENT: Format the answer primarily as a clear, well-organized Markdown comparison table "
            "with informative column headers, accompanied by a concise explanatory summary and page citations."
        )
    elif _STEPS_PATTERN.search(q):
        instructions.append(
            "FORMAT REQUIREMENT: Format the answer as numbered step-by-step instructions (1, 2, 3...), "
            "with clear explanations of each step's objective, action, and rationale."
        )
    elif _BULLET_PATTERN.search(q):
        instructions.append(
            "FORMAT REQUIREMENT: Format the key principles or findings as a clean bulleted list with bolded headings "
            "and in-depth explanations for each point."
        )
    elif _SHORT_PATTERN.search(q):
        instructions.append(
            "FORMAT REQUIREMENT: Provide a concise executive answer in 2-3 focused sentences with exact citations."
        )
    elif _DETAILED_PATTERN.search(q) or any(w in q for w in ["explain", "how", "what is", "why", "breakdown", "guide", "understand"]):
        instructions.append(
            "FORMAT REQUIREMENT: Provide a rich, structured pedagogical explanation. Start with an executive summary, "
            "followed by detailed subheadings (###), bulleted breakdowns of mechanisms and concepts, "
            "concrete examples from the book, and exact page citations."
        )
    else:
        instructions.append(
            "FORMAT REQUIREMENT: Deliver a clear, well-structured explanation using subheadings (###) and bulleted points "
            "where helpful, supported by concrete examples from the book and exact page citations."
        )

    return " ".join(instructions)
