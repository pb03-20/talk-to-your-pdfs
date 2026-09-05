<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Talk to Your PDFs

Upload PDFs, ask grounded questions with page citations, and use Gemini-powered text and live voice responses. The production deployment is a single Render web service: FastAPI serves both the API and the built React application.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, choose **New + → Blueprint** and select the repository. Render reads [`render.yaml`](./render.yaml) and builds the included Docker image.
3. Set `GEMINI_API_KEY` in the Render environment. Optionally set `MONGODB_URI` and its related `MONGODB_*` values to persist vectors beyond a service restart.
4. Deploy. Render provides the public URL; the frontend, API, PDF uploads, and WebSocket endpoint are all served from it.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for details.

## Run locally

**Prerequisites:** Node.js 20+ and Python 3.11+.

1. Install frontend dependencies: `npm ci`
2. Build the frontend: `npm run build:client`
3. Install the backend: `pip install -r backend/requirements.txt`
4. Set `GEMINI_API_KEY` in `.env`.
5. Start the service: `uvicorn backend.main:app --host 0.0.0.0 --port 8000`
