# Talk to Your PDFs - Architecture & Deployment Guide

An interactive web application enabling users to upload multiple large PDFs (including 50+ MBBS textbooks), extract and index their contents using PyMuPDF and Gemini RAG, ask questions with grounded citations, and hold live spoken voice conversations using Google Gemini.

---

## 1. System Architecture

```
                                    ┌────────────────────────┐
                                    │    Google Gemini API   │
                                    │  - gemini-2.5-flash    │
                                    │  - text-embedding-004  │
                                    │  - gemini-2.5-pro      │
                                    └───────────▲────────────┘
                                                │
[User Browser] ──(HTTP/WS)────────► [Render / FastAPI Backend Server]
  • React 19 + Tailwind CSS          • High-Performance PyMuPDF Parser
  • Citation Modal & Highlights      • Hybrid Retrieval (BM25 + Gemini RRF)
  • Non-Silent TTS Synthesis         • Bi-directional WebSockets (Live Voice)
```

---

## 2. Deploying on Render (100% Free - Unlimited Large File Uploads)

Deploying on **Render** gives you a full dedicated web service with **NO 4.5 MB serverless upload limit**, real WebSockets, and PyMuPDF document extraction.

### Option A: Render Blueprints (Easiest - 1 Click)

1. **Push your code to GitHub**.
2. Log into [Render.com](https://dashboard.render.com/).
3. Click **New +** -> **Blueprint**.
4. Select your GitHub repository. Render will automatically read `render.yaml`.
5. Under Environment Variables, set:
   - `GEMINI_API_KEY`: `your_gemini_api_key_here`
6. Click **Apply**. Render will automatically build the React frontend and deploy the FastAPI backend.

### Option B: Manual Web Service on Render

1. Go to [Render Dashboard](https://dashboard.render.com/) -> **New Web Service**.
2. Select your repository.
3. Choose **Python 3** environment.
4. Set **Build Command**: `./build.sh`
5. Set **Start Command**: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
6. Under Environment Variables, add:
   - `GEMINI_API_KEY`: `your_gemini_api_key_here`
   - `PYTHON_VERSION`: `3.11.0`
7. Select **Free Tier** and click **Create Web Service**.

---

## 3. Running Locally

### Option A: Python FastAPI (Full Performance Mode)
```bash
# Build React frontend assets
npm install
npm run build:client

# Start Python FastAPI backend
cd backend
python -m venv venv
# On Windows: .\venv\Scripts\activate
# On Linux/Mac: source venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY="your_api_key_here"
uvicorn main:app --reload --port 8000
```
Open `http://localhost:8000` in your browser.

### Option B: Node.js Express Dev Server
```bash
npm install
npm run dev
```
Open `http://localhost:3000` in your browser.

---

## 4. Deploying to Vercel (Optional Serverless Mode)

If deploying to Vercel, note that Vercel enforces a **4.5 MB HTTP payload limit** for Serverless Functions. PDFs must be under 4.5 MB per upload request when using Vercel serverless functions.
