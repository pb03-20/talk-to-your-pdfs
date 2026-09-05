#!/usr/bin/env bash
# Exit immediately on error
set -o errexit

echo "--- Building React Frontend ---"
npm install
npm run build:client

echo "--- Installing Python Backend Dependencies ---"
pip install -r backend/requirements.txt

echo "--- Build Completed Successfully ---"
