"""
FastAPI Backend for 'Talk to Your PDFs' with PyMuPDF and Google Gemini API.
"""

import os
import re
import time
import json
import uuid
import base64
import asyncio
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, UploadFile, File, Form, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types

from rag import (
    extract_pdf_pages_pymupdf,
    chunk_pages,
    embed_text_gemini,
    embed_texts_batch,
    cosine_similarity,
    get_gemini_client,
    WorkspaceBM25Index,
    generate_query_variations,
    reciprocal_rank_fusion,
    mmr_select,
    hybrid_retrieve,
    estimate_tokens,
    build_full_document_context,
    fits_full_context,
    summarize_document,
    looks_like_overview_query,
    TEACHER_PERSONA_PROMPT,
    build_format_instruction,
    PDFExtractionError,
    LONG_CONTEXT_MODEL,
    GENERATION_MODEL,
)

app = FastAPI(title="Talk to Your PDFs API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory vector store and workspace partitioning
workspaces: Dict[str, Dict[str, Any]] = {}

def get_or_create_workspace(ws_id: str) -> Dict[str, Any]:
    if ws_id not in workspaces:
        workspaces[ws_id] = {
            "id": ws_id,
            "created_at": time.time(),
            "documents": [],
            "chunks": [],
            "messages": [
                {
                    "id": "welcome",
                    "role": "model",
                    "content": "Hello! Upload your PDFs in the sidebar, and I'll index them and answer with exact page citations.",
                    "timestamp": time.time()
                }
            ],
            "bm25_index": None,
            "summaries": {},
        }
    return workspaces[ws_id]

def refresh_workspace_bm25(ws: Dict[str, Any]):
    chunks = ws.get("chunks", [])
    if chunks:
        ws["bm25_index"] = WorkspaceBM25Index(chunks)
    else:
        ws["bm25_index"] = None

class ChatRequest(BaseModel):
    message: str

class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = "Kore"

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "Talk to Your PDFs FastAPI"}

@app.get("/api/workspace")
def get_workspace(x_workspace_id: Optional[str] = Header("default")):
    ws = get_or_create_workspace(x_workspace_id)
    return {
        "workspaceId": ws["id"],
        "documents": ws["documents"],
        "totalChunks": len(ws["chunks"]),
        "messages": ws["messages"]
    }

@app.post("/api/upload")
async def upload_pdfs(
    files: List[UploadFile] = File(...),
    x_workspace_id: Optional[str] = Header("default")
):
    ws = get_or_create_workspace(x_workspace_id)
    processed = []
    MAX_FILE_SIZE = 100 * 1024 * 1024  # 100MB max per file

    for file in files:
        doc_id = f"doc_{uuid.uuid4().hex[:12]}"
        try:
            content = await file.read()
            if len(content) > MAX_FILE_SIZE:
                raise HTTPException(
                    status_code=413,
                    detail=f"File '{file.filename}' is too large ({len(content)/(1024*1024):.1f}MB). Maximum supported size is 100MB."
                )

            total_pages, pages = extract_pdf_pages_pymupdf(content)
            chunks = chunk_pages(x_workspace_id, doc_id, file.filename, pages)

            # Generate embeddings for each chunk in batch
            texts = [c["text"] for c in chunks]
            if texts:
                embeddings = embed_texts_batch(texts)
                for chunk, (emb_vec, emb_kind) in zip(chunks, embeddings):
                    chunk["embedding"] = emb_vec
                    chunk["embedding_kind"] = emb_kind

            ws["chunks"].extend(chunks)

            # Generate abstractive document summary
            summary = ""
            if chunks:
                try:
                    summary = summarize_document(file.filename, chunks)
                    ws.setdefault("summaries", {})[doc_id] = summary
                except Exception as sum_err:
                    print(f"Warning: Failed to generate document summary for {file.filename}: {sum_err}")

            doc_meta = {
                "id": doc_id,
                "filename": file.filename,
                "fileSize": len(content),
                "totalPages": total_pages,
                "totalChunks": len(chunks),
                "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "status": "ready"
            }
            ws["documents"].append(doc_meta)
            processed.append(doc_meta)

        except PDFExtractionError as pe:
            doc_meta = {
                "id": doc_id,
                "filename": file.filename,
                "fileSize": 0,
                "totalPages": 0,
                "totalChunks": 0,
                "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "status": "error",
                "error": str(pe)
            }
            processed.append(doc_meta)
        except Exception as e:
            doc_meta = {
                "id": doc_id,
                "filename": file.filename,
                "fileSize": 0,
                "totalPages": 0,
                "totalChunks": 0,
                "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "status": "error",
                "error": f"Upload error: {str(e)}"
            }
            processed.append(doc_meta)

    # Rebuild workspace BM25 index with updated chunks
    refresh_workspace_bm25(ws)

    return {
        "success": True,
        "processed": processed,
        "documents": ws["documents"],
        "totalChunks": len(ws["chunks"])
    }

@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str, x_workspace_id: Optional[str] = Header("default")):
    ws = get_or_create_workspace(x_workspace_id)
    ws["documents"] = [d for d in ws["documents"] if d["id"] != doc_id]
    ws["chunks"] = [c for c in ws["chunks"] if c["doc_id"] != doc_id]
    if "summaries" in ws and doc_id in ws["summaries"]:
        del ws["summaries"][doc_id]
    refresh_workspace_bm25(ws)
    return {
        "success": True,
        "documents": ws["documents"],
        "totalChunks": len(ws["chunks"])
    }

@app.post("/api/chat")
async def chat_rag(req: ChatRequest, x_workspace_id: Optional[str] = Header("default")):
    ws = get_or_create_workspace(x_workspace_id)
    query = req.message.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    user_msg_id = f"u_{uuid.uuid4().hex}"
    ws["messages"].append({
        "id": user_msg_id,
        "role": "user",
        "content": query,
        "timestamp": time.time()
    })

    all_chunks = ws["chunks"]
    if not all_chunks:
        answer = "No documents have been uploaded yet. Please upload PDFs to start asking questions!"
        sources = []
    else:
        # Group chunks by document
        doc_chunks_map: Dict[str, List[Dict[str, Any]]] = {}
        for c in all_chunks:
            doc_chunks_map.setdefault(c["filename"], []).append(c)

        # Strategy 1: Check if workspace fits in full context window
        if fits_full_context(doc_chunks_map):
            full_context = build_full_document_context(doc_chunks_map)
            context_str = full_context
            sources = [
                {
                    "docId": d["id"],
                    "filename": d["filename"],
                    "pageNumber": 1,
                    "snippet": f"Full document context mode active ({d['totalPages']} pages)",
                    "score": 1.0
                }
                for d in ws["documents"]
            ]
        # Strategy 2: Overview / summary query check
        elif looks_like_overview_query(query) and ws.get("summaries"):
            summaries_str = "\n\n".join([
                f"[Document: {filename}]\n{summary}"
                for filename, summary in ws.get("summaries", {}).items()
            ])
            context_str = f"Document Overviews:\n{summaries_str}"
            sources = [
                {
                    "docId": d["id"],
                    "filename": d["filename"],
                    "pageNumber": 1,
                    "snippet": ws.get("summaries", {}).get(d["id"], "Document summary available")[:240],
                    "score": 0.95
                }
                for d in ws["documents"]
            ]
        # Strategy 3: Hybrid Retrieval (BM25 + Gemini Embeddings + RRF + MMR)
        else:
            bm25 = ws.get("bm25_index")
            if bm25 is None:
                refresh_workspace_bm25(ws)
                bm25 = ws.get("bm25_index")

            retrieved_chunks = hybrid_retrieve(
                query=query,
                chunks=all_chunks,
                bm25_index=bm25,
                top_k=6,
                use_query_expansion=True
            )

            sources = [
                {
                    "docId": sc["doc_id"],
                    "filename": sc["filename"],
                    "pageNumber": sc["page_number"],
                    "snippet": sc["text"][:240],
                    "score": 0.9
                }
                for sc in retrieved_chunks
            ]

            context_str = "\n\n".join([
                f"[Source: {sc['filename']}, Page {sc['page_number']}]\n{sc['text']}"
                for sc in retrieved_chunks
            ])

        format_instruction = build_format_instruction(query)
        system_prompt = (
            f"{TEACHER_PERSONA_PROMPT}\n\n"
            "STRICT GROUNDING RULES:\n"
            "1. Ground your answer strictly in the provided PDF context.\n"
            "2. If the information is NOT in the PDFs, explicitly state: 'I could not find information about this in the uploaded PDFs.'\n"
            "3. Always cite the exact PDF document filename and page number for every fact.\n"
            f"4. {format_instruction}"
        )

        user_content = f"PDF Context:\n{context_str}\n\nUser Question: {query}"

        client = get_gemini_client()
        try:
            response = client.models.generate_content(
                model=GENERATION_MODEL,
                contents=user_content,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=0.2
                )
            )
            answer = response.text or "No response generated."
        except Exception as e:
            # Fallback model with full system instruction preserved
            try:
                response = client.models.generate_content(
                    model="gemini-flash-latest",
                    contents=user_content,
                    config=types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        temperature=0.2
                    )
                )
                answer = response.text or "Encountered a temporary issue generating the response."
            except Exception as e2:
                raise HTTPException(status_code=500, detail=f"AI generation failed: {str(e2)}")

    model_msg_id = f"m_{uuid.uuid4().hex}"
    ws["messages"].append({
        "id": model_msg_id,
        "role": "model",
        "content": answer,
        "sources": sources,
        "timestamp": time.time()
    })

    return {
        "answer": answer,
        "sources": sources,
        "messageId": model_msg_id
    }

def _clean_text_for_tts(text: str) -> str:
    cleaned = re.sub(r"\[.*?\]", "", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned

def _chunk_text_for_tts(text: str, max_chars: int = 800) -> List[str]:
    if len(text) <= max_chars:
        return [text] if text else []
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks = []
    current = ""
    for sent in sentences:
        if len(current) + len(sent) + 1 <= max_chars:
            current = (current + " " + sent).strip()
        else:
            if current:
                chunks.append(current)
            if len(sent) > max_chars:
                for i in range(0, len(sent), max_chars):
                    chunks.append(sent[i:i + max_chars])
                current = ""
            else:
                current = sent
    if current:
        chunks.append(current)
    return chunks

@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    clean_text = _clean_text_for_tts(req.text)
    MAX_TTS_TOTAL = 4000
    is_truncated = len(clean_text) > MAX_TTS_TOTAL
    if is_truncated:
        clean_text = clean_text[:MAX_TTS_TOTAL]

    text_chunks = _chunk_text_for_tts(clean_text, max_chars=800)
    if not text_chunks:
        raise HTTPException(status_code=400, detail="No speakable text found")

    client = get_gemini_client()
    audio_bytes_list = []

    for chunk in text_chunks:
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[{"parts": [{"text": chunk}]}],
                config=types.GenerateContentConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=req.voice or "Kore")
                        )
                    )
                )
            )
            raw_data = response.candidates[0].content.parts[0].inline_data.data
            if isinstance(raw_data, str):
                audio_bytes_list.append(base64.b64decode(raw_data))
            elif isinstance(raw_data, bytes):
                audio_bytes_list.append(raw_data)
        except Exception as e:
            if not audio_bytes_list:
                raise HTTPException(status_code=500, detail=f"TTS generation error: {str(e)}")
            break

    combined_audio = b"".join(audio_bytes_list)
    combined_b64 = base64.b64encode(combined_audio).decode("utf-8")

    return {
        "audio": combined_b64,
        "sampleRate": 24000,
        "totalCharacters": len(clean_text),
        "chunksProcessed": len(audio_bytes_list),
        "isTruncated": is_truncated
    }

@app.websocket("/api/live-voice")
async def websocket_live_voice(websocket: WebSocket, workspaceId: str = "default"):
    await websocket.accept()
    ws = get_or_create_workspace(workspaceId)
    docs = ws["documents"]
    doc_summary = "\n".join([f"- {d['filename']} ({d['totalPages']} pages)" for d in docs])

    system_instruction = (
        f"You are the voice assistant for 'Talk to Your PDFs'.\n"
        f"Documents in workspace:\n{doc_summary or 'No documents'}\n"
        f"Answer the user's questions clearly, concisely, and factually based on their PDFs. "
        f"Cite page numbers when stating facts. If not in the PDFs, say you could not find it."
    )

    client = get_gemini_client()
    try:
        async with client.aio.live.connect(
            model="gemini-2.5-flash",
            config=types.LiveConnectConfig(
                response_modalities=[types.Modality.AUDIO],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Zephyr")
                    )
                ),
                system_instruction=system_instruction
            )
        ) as session:
            await websocket.send_json({"type": "status", "message": "Gemini Live connected"})

            async def send_to_gemini():
                while True:
                    data = await websocket.receive_json()
                    if data.get("type") == "audio" and data.get("audio"):
                        audio_data = data["audio"]
                        if isinstance(audio_data, str):
                            audio_bytes = base64.b64decode(audio_data)
                        else:
                            audio_bytes = audio_data
                        await session.send_realtime_input(
                            audio=types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                        )

            async def receive_from_gemini():
                async for response in session.receive():
                    server_content = response.server_content
                    if server_content is not None:
                        model_turn = server_content.model_turn
                        if model_turn is not None:
                            for part in model_turn.parts:
                                if part.inline_data:
                                    part_data = part.inline_data.data
                                    if isinstance(part_data, bytes):
                                        audio_b64 = base64.b64encode(part_data).decode("utf-8")
                                    else:
                                        audio_b64 = part_data
                                    await websocket.send_json({"type": "audio", "audio": audio_b64})
                                if part.text:
                                    await websocket.send_json({"type": "text", "text": part.text})

            await asyncio.gather(send_to_gemini(), receive_from_gemini())
    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})

# Static files for built React SPA frontend (for Render / Docker single-container deployment)
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

dist_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist")
if os.path.exists(dist_dir):
    assets_dir = os.path.join(dist_dir, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("health"):
            raise HTTPException(status_code=404, detail="Not Found")
        file_path = os.path.join(dist_dir, full_path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(dist_dir, "index.html"))

