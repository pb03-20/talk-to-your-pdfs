"""
FastAPI Backend for 'Talk to Your PDFs' with PyMuPDF and Google Gemini API.
"""

import os
import time
import json
import uuid
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
    cosine_similarity,
    get_gemini_client,
)

app = FastAPI(title="Talk to Your PDFs API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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
            ]
        }
    return workspaces[ws_id]

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

    for file in files:
        doc_id = f"doc_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        content = await file.read()

        total_pages, pages = extract_pdf_pages_pymupdf(content)
        chunks = chunk_pages(x_workspace_id, doc_id, file.filename, pages)

        # Generate embeddings for each chunk
        for chunk in chunks:
            chunk["embedding"] = embed_text_gemini(chunk["text"])

        ws["chunks"].extend(chunks)
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

    # Record user message
    ws["messages"].append({
        "id": f"u_{int(time.time())}",
        "role": "user",
        "content": query,
        "timestamp": time.time()
    })

    # Retrieve matching chunks
    all_chunks = ws["chunks"]
    if not all_chunks:
        answer = "No documents have been uploaded yet. Please upload PDFs to start asking questions!"
        sources = []
    else:
        q_embedding = embed_text_gemini(query)
        scored = []
        for c in all_chunks:
            sim = cosine_similarity(q_embedding, c.get("embedding", []))
            scored.append({"chunk": c, "score": sim})
        scored.sort(key=lambda x: x["score"], reverse=True)
        top_chunks = scored[:5]

        # Check anti-hallucination threshold
        high_conf_chunks = [sc for sc in top_chunks if sc["score"] > 0.15]
        if not high_conf_chunks:
            high_conf_chunks = top_chunks[:2]

        sources = [
            {
                "docId": sc["chunk"]["doc_id"],
                "filename": sc["chunk"]["filename"],
                "pageNumber": sc["chunk"]["page_number"],
                "snippet": sc["chunk"]["text"][:240],
                "score": round(sc["score"], 2)
            }
            for sc in high_conf_chunks
        ]

        context_str = "\n\n".join([
            f"[Source: {sc['chunk']['filename']}, Page {sc['chunk']['page_number']}]\n{sc['chunk']['text']}"
            for sc in high_conf_chunks
        ])

        system_prompt = (
            "You are an expert document assistant. Ground your answer strictly in the provided PDF context.\n"
            "If the information is NOT in the PDFs, explicitly state: 'I could not find information about this in the uploaded PDFs.'\n"
            "Always cite the exact PDF document filename and page number."
        )

        user_content = f"Context:\n{context_str}\n\nQuestion: {query}"

        client = get_gemini_client()
        try:
            response = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=user_content,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=0.2
                )
            )
            answer = response.text or "No response generated."
        except Exception as e:
            # Fallback model
            response = client.models.generate_content(
                model="gemini-flash-latest",
                contents=user_content
            )
            answer = response.text or "Encountered a temporary issue generating the response."

    # Record model response
    model_msg_id = f"m_{int(time.time())}"
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

@app.post("/api/tts")
async def text_to_speech(req: TTSRequest):
    client = get_gemini_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.1-flash-tts-preview",
            contents=[{"parts": [{"text": req.text[:1000]}]}],
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=req.voice or "Kore")
                    )
                )
            )
        )
        audio_b64 = response.candidates[0].content.parts[0].inline_data.data
        return {"audio": audio_b64, "sampleRate": 24000}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
            model="gemini-3.1-flash-live-preview",
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

            # Receive client audio and forward
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "audio" and data.get("audio"):
                    await session.send_realtime_input(
                        audio=types.Blob(data=data["audio"], mime_type="audio/pcm;rate=16000")
                    )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.send_json({"type": "error", "message": str(e)})
