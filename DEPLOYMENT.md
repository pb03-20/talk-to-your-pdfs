# Talk to Your PDFs - Architecture & Deployment Guide

An interactive web application enabling users to upload multiple PDFs, extract and index their contents using RAG, ask questions with grounded citations, and hold live spoken voice conversations using Google Gemini.

---

## 1. System Architecture

```
                                    ┌────────────────────────┐
                                    │    Google Gemini API   │
                                    │  - gemini-3.8-flash    │
                                    │  - gemini-embedding-2  │
                                    │  - gemini-3.1-live     │
                                    │  - gemini-3.1-tts      │
                                    └───────────▲────────────┘
                                                │
[User Browser] ──(HTTP/SSE/WS)──► [Web Server / Backend Service]
  • React 19 + Tailwind             • Ephemeral Workspace Isolation
  • Web Audio API (16kHz / 24kHz)    • PDF Page Parsing & Extraction
  • Live Transcripts & Citations    • Vector Embeddings & Hybrid Search
```

---

## 2. Core Capabilities

- **Multi-PDF Upload**: Upload one or multiple PDFs simultaneously.
- **Page-Level Extraction**: Extracts and segments documents while preserving exact page provenance.
- **RAG & Embeddings**: Generates dense semantic vectors using `gemini-embedding-2-preview` with hybrid lexical fallback.
- **Anti-Hallucination Guardrails**: If information is absent from uploaded PDFs, the model explicitly refuses to fabricate answers.
- **Gemini Live Voice**: Bidirectional low-latency voice conversations over WebSockets (`gemini-3.1-flash-live-preview`) with real-time speech transcription.
- **Anonymous Workspace Isolation**: Each visitor receives an ephemeral workspace token (`x-workspace-id`) with partitioned vector stores.

---

## 3. Local & Container Execution (Current Applet)

The repository runs a unified high-performance Node/Express + Vite server on port 3000:

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

---

## 4. Deploying to Vercel (Frontend / Full-Stack)

1. **Push to GitHub**:
   Ensure your code is pushed to your Git provider.

2. **Import into Vercel**:
   - Go to [Vercel Dashboard](https://vercel.com/new).
   - Select your repository.
   - Framework Preset: **Vite**
   - Root Directory: `./`
   - Build Command: `npm run build`
   - Output Directory: `dist`

3. **Configure Environment Variables in Vercel**:
   - `GEMINI_API_KEY`: Your Google Gemini API Key.

---

## 5. Deploying Python + FastAPI Backend (Standalone)

The `/backend` folder contains a complete Python FastAPI + PyMuPDF implementation:

### Running Locally:
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY="your-gemini-api-key"
uvicorn main:app --reload --port 8000
```

### Deploying to Google Cloud Run:
```bash
cd backend
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/pdf-rag-backend
gcloud run deploy pdf-rag-backend \
  --image gcr.io/YOUR_PROJECT_ID/pdf-rag-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY="YOUR_KEY"
```

### Deploying to Render / Railway:
- Set Build Command: `pip install -r backend/requirements.txt`
- Set Start Command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
- Add Environment Variable: `GEMINI_API_KEY`
