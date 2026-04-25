FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3-pip libgl1-mesa-glx libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pipeline.py export.py ./

# Model weights are mounted at runtime:
#   docker run -v /host/models/TATR_TD:/models/TATR_TD \
#              -v /host/models/TableStructureDetection:/models/TableStructureDetection \
#              -v /host/models/ocr_models:/models/ocr_models \
#              -v /host/images:/images \
#              table-pipeline /images/page.png
ENV TD_MODEL_DIR=/models/TATR_TD
ENV TSR_MODEL_DIR=/models/TableStructureDetection
ENV OCR_MODEL_DIR=/models/ocr_models

ENTRYPOINT ["python3", "pipeline.py"]
