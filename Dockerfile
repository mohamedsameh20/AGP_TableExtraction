# ===========================================================================
#  Ag27 — Table Extractor
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
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3-pip libgl1-mesa-glx libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pipeline.py export.py server.py ./

# Copy built frontend from stage 1
COPY --from=frontend-build /build/dist ./web/dist/

# Model weights are mounted at runtime:
#   docker run -v /host/models/TATR_TD:/models/TATR_TD \
#              -v /host/models/TableStructureDetection:/models/TableStructureDetection \
#              -v /host/models/ocr_models:/models/ocr_models \
#              ag27
ENV TD_MODEL_DIR=/models/TATR_TD
ENV TSR_MODEL_DIR=/models/TableStructureRecognition
ENV OCR_MODEL_DIR=/models/ocr_models
ENV PIPELINE_DEVICE=auto
ENV PREWARM_PIPELINE_ON_STARTUP=1

EXPOSE 8000

ENTRYPOINT ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
