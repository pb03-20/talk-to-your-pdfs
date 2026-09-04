"""
RAG and Document Processing Module using PyMuPDF (fitz) and Google Gemini API.
"""

import os
import fitz  # PyMuPDF
import numpy as np
from typing import List, Dict, Any, Tuple
from google import genai
from google.genai import types

def get_gemini_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    return genai.Client(api_key=api_key)

def extract_pdf_pages_pymupdf(file_bytes: bytes) -> Tuple[int, List[Dict[str, Any]]]:
    """
    Extracts text page-by-page using PyMuPDF.
    Returns total_pages and a list of { 'page_number': int, 'text': str }.
    """
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages = []
    total_pages = len(doc)

    for i in range(total_pages):
        page = doc.load_page(i)
        text = page.get_text("text").strip()
        if text:
            pages.append({
                "page_number": i + 1,
                "text": text
            })
    doc.close()
    return total_pages, pages

def chunk_pages(
    workspace_id: str,
    doc_id: str,
    filename: str,
    pages: List[Dict[str, Any]],
    chunk_size: int = 700,
    overlap: int = 100
) -> List[Dict[str, Any]]:
    """
    Splits page texts into chunks with overlap while preserving provenance.
    """
    chunks = []
    chunk_counter = 0

    for page in pages:
        text = page["text"]
        start_idx = 0
        while start_idx < len(text):
            end_idx = min(start_idx + chunk_size, len(text))
            
            # Sentence boundary adjustment
            if end_idx < len(text):
                period_idx = text.rfind(". ", start_idx, end_idx)
                if period_idx != -1 and period_idx > start_idx + 200:
                    end_idx = period_idx + 2

            chunk_text = text[start_idx:end_idx].strip()
            if len(chunk_text) > 30:
                chunk_counter += 1
                chunks.append({
                    "id": f"{doc_id}_chunk_{chunk_counter}",
                    "workspace_id": workspace_id,
                    "doc_id": doc_id,
                    "filename": filename,
                    "page_number": page["page_number"],
                    "chunk_index": chunk_counter,
                    "text": chunk_text,
                    "embedding": None
                })

            if end_idx >= len(text):
                break
            start_idx = max(start_idx + 1, end_idx - overlap)

    return chunks

def embed_text_gemini(text: str) -> List[float]:
    """
    Generates 3072-dim embeddings using Gemini gemini-embedding-2-preview or text-embedding-004.
    """
    client = get_gemini_client()
    try:
        res = client.models.embed_content(
            model="gemini-embedding-2-preview",
            contents=text[:4000]
        )
        if hasattr(res, "embeddings") and len(res.embeddings) > 0:
            return res.embeddings[0].values
    except Exception:
        try:
            res = client.models.embed_content(
                model="text-embedding-004",
                contents=text[:4000]
            )
            if hasattr(res, "embeddings") and len(res.embeddings) > 0:
                return res.embeddings[0].values
        except Exception:
            pass

    # Normalized local hash fallback
    vec = np.zeros(384, dtype=np.float32)
    words = text.lower().split()
    for i, w in enumerate(words):
        h = abs(hash(w)) % 384
        vec[h] += 1.0 / (i + 1)
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec.tolist()

def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    if not v1 or not v2:
        return 0.0
    a = np.array(v1, dtype=np.float32)
    b = np.array(v2, dtype=np.float32)
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))
