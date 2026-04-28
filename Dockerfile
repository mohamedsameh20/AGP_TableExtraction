# ===========================================================================
#  Agent P-DF — Table Extractor (CPU Portable)
#  Multi-stage build: Node (frontend) → Python (backend)
# ===========================================================================

# --- Stage 1: Build React frontend ---
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Stage 2: Python runtime ---
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Optimize dependencies (strip heavy unneeded PySide6)
COPY requirements.txt .
RUN grep -v PySide6 requirements.txt > requirements-docker.txt && \
    pip install --no-cache-dir -r requirements-docker.txt

# Copy machine learning models directly into the image
COPY TATR_TD/ /models/TATR_TD/
COPY TableStructureRecognition/ /models/TableStructureRecognition/
COPY ocr_models/ /models/ocr_models/

# Copy Backend Python files
COPY pipeline.py export.py server.py ./

# Copy built frontend from stage 1
COPY --from=frontend-build /build/dist ./web/dist/

# Set environment paths and force CPU inference
ENV TD_MODEL_DIR=/models/TATR_TD
ENV TSR_MODEL_DIR=/models/TableStructureRecognition
ENV OCR_MODEL_DIR=/models/ocr_models
ENV PIPELINE_DEVICE=cpu
ENV PREWARM_PIPELINE_ON_STARTUP=1
ENV PORT=8001

EXPOSE 8001

CMD ["sh", "-c", "python3 -m uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001}"]
