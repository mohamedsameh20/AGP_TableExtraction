"""Ag27 — FastAPI Web Server for Table Extraction Pipeline.

Wraps the existing 5-phase pipeline (TD → TSR → OCR → Cell Assignment)
behind a REST API and serves the React frontend.
"""
from __future__ import annotations

import io
import json
import logging
import os
import shutil
import threading
import time
import uuid
import zipfile
from collections import deque
from enum import Enum
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from fastapi.staticfiles import StaticFiles
from starlette.responses import HTMLResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# App & Config
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Ag27 — Table Extractor",
    description="AI-powered table detection, structure recognition, and OCR from document images.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", "./uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Health Metrics (in-memory)
# ---------------------------------------------------------------------------
_server_start_time = time.time()
_health_lock = threading.Lock()
_health_metrics: dict[str, Any] = {
    "total_jobs": 0,
    "successful_jobs": 0,
    "failed_jobs": 0,
    "latencies": deque(maxlen=500),
    "recent_errors": deque(maxlen=50),
}


def _record_job_success(job_id: str, duration: float):
    with _health_lock:
        _health_metrics["total_jobs"] += 1
        _health_metrics["successful_jobs"] += 1
        _health_metrics["latencies"].append({"job_id": job_id, "duration": duration, "timestamp": time.time()})


def _record_job_failure(job_id: str, error: str):
    with _health_lock:
        _health_metrics["total_jobs"] += 1
        _health_metrics["failed_jobs"] += 1
        _health_metrics["recent_errors"].append({"job_id": job_id, "error": error, "timestamp": time.time()})


# ---------------------------------------------------------------------------
# Job store (in-memory for single-process deployment)
# ---------------------------------------------------------------------------

class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    DONE = "done"
    ERROR = "error"


jobs: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# PDF Conversion (pymupdf/fitz)
# ---------------------------------------------------------------------------

def _convert_pdf_to_images(pdf_path: Path, output_dir: Path, dpi: int = 200) -> list[Path]:
    """Convert a PDF file to a list of PNG images using pymupdf."""
    import fitz  # pymupdf

    doc = fitz.open(str(pdf_path))
    image_paths: list[Path] = []
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)

    for page_idx in range(len(doc)):
        page = doc[page_idx]
        pix = page.get_pixmap(matrix=mat)
        img_path = output_dir / f"page_{page_idx:03d}.png"
        pix.save(str(img_path))
        image_paths.append(img_path)

    doc.close()
    return image_paths


# ---------------------------------------------------------------------------
# Pipeline runner (background thread)
# ---------------------------------------------------------------------------

_pipeline_lock = threading.Lock()


@app.on_event("startup")
async def _maybe_prewarm_pipeline():
    if os.environ.get("PREWARM_PIPELINE_ON_STARTUP", "").strip().lower() not in {"1", "true", "yes", "on"}:
        return
    logger.info("Prewarming pipeline runtimes at server startup")
    try:
        with _pipeline_lock:
            from pipeline import prewarm_pipeline_runtimes
            prewarm_pipeline_runtimes()
    except Exception:
        logger.exception("Pipeline prewarm failed during startup")


def _run_pipeline_thread(job_id: str):
    """Run the heavy pipeline in a background thread."""
    job = jobs[job_id]
    job["status"] = JobStatus.PROCESSING
    job["started_at"] = time.time()

    logger.info("Starting pipeline for job %s", job_id)

    try:
        with _pipeline_lock:
            from pipeline import run_pipeline
            from PIL import Image

            image_paths = job.get("image_paths", [job["image_path"]])
            all_annotations: list[dict] = []
            page_count = len(image_paths)

            for page_idx, img_path in enumerate(image_paths):
                logger.info("Job %s: processing page %d/%d (%s)", job_id, page_idx + 1, page_count, img_path)
                annotation = run_pipeline(img_path)
                # Tag each table with page info
                for table in annotation.get("tables", []):
                    table["page"] = page_idx
                all_annotations.append(annotation)

            # Merge annotations across pages
            merged_tables = []
            global_table_id = 0
            for page_idx, ann in enumerate(all_annotations):
                for table in ann.get("tables", []):
                    table["table_id"] = global_table_id
                    merged_tables.append(table)
                    global_table_id += 1

            first_ann = all_annotations[0] if all_annotations else {}
            merged_annotation = {
                "source_image": job["image_name"],
                "image_size": first_ann.get("image_size", [0, 0]),
                "page_count": page_count,
                "tables": merged_tables,
            }

            # Save table crops
            job_dir = Path(job["image_path"]).parent
            for table in merged_tables:
                page_idx = table.get("page", 0)
                page_img_path = image_paths[page_idx] if page_idx < len(image_paths) else image_paths[0]
                pil = Image.open(page_img_path).convert("RGB")
                bbox = table["bbox"]
                x1, y1, x2, y2 = [int(v) for v in bbox]
                w, h = pil.size
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(w, x2), min(h, y2)
                if x2 > x1 and y2 > y1:
                    crop = pil.crop((x1, y1, x2, y2))
                    crop_path = job_dir / f"table_{table['table_id']}.png"
                    crop.save(str(crop_path))

        job["annotation"] = merged_annotation
        job["status"] = JobStatus.DONE
        job["finished_at"] = time.time()
        job["duration"] = round(job["finished_at"] - job["started_at"], 2)
        logger.info("Job %s done in %.1fs", job_id, job["duration"])
        _record_job_success(job_id, job["duration"])

    except Exception as e:
        logger.exception("Job %s failed", job_id)
        job["status"] = JobStatus.ERROR
        job["error"] = str(e)
        job["finished_at"] = time.time()
        _record_job_failure(job_id, str(e))


def _start_pipeline(job_id: str):
    """Start the pipeline in a background thread."""
    t = threading.Thread(target=_run_pipeline_thread, args=(job_id,), daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif"}
PDF_EXTS = {".pdf"}
ACCEPTED_EXTS = IMAGE_EXTS | PDF_EXTS


@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    """Upload an image or PDF and get a job_id back."""
    ext = Path(file.filename or "image.jpg").suffix.lower()
    if ext not in ACCEPTED_EXTS:
        raise HTTPException(400, f"Unsupported file type: {ext}. Accepted: {', '.join(sorted(ACCEPTED_EXTS))}")

    job_id = str(uuid.uuid4())[:12]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Preserve original filename
    safe_name = (file.filename or f"image{ext}").replace(" ", "_")
    dest = job_dir / safe_name
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    # For PDFs, convert to images
    is_pdf = ext in PDF_EXTS
    image_paths: list[str] = []
    if is_pdf:
        try:
            pages = _convert_pdf_to_images(dest, job_dir)
            image_paths = [str(p) for p in pages]
            primary_image = str(pages[0]) if pages else str(dest)
        except Exception as e:
            raise HTTPException(400, f"Failed to convert PDF: {e}")
    else:
        primary_image = str(dest)
        image_paths = [str(dest)]

    jobs[job_id] = {
        "id": job_id,
        "status": JobStatus.QUEUED,
        "image_path": primary_image,
        "image_paths": image_paths,
        "image_name": safe_name,
        "is_pdf": is_pdf,
        "annotation": None,
        "error": None,
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "duration": None,
    }

    return {"job_id": job_id, "filename": safe_name, "is_pdf": is_pdf, "page_count": len(image_paths)}


@app.post("/api/process/{job_id}")
async def process_image(job_id: str):
    """Trigger pipeline processing for an uploaded image."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] not in (JobStatus.QUEUED, JobStatus.ERROR):
        return {"job_id": job_id, "status": job["status"], "message": "Already processing or done"}

    job["status"] = JobStatus.QUEUED
    _start_pipeline(job_id)
    return {"job_id": job_id, "status": "queued"}


@app.post("/api/upload-and-process")
async def upload_and_process(file: UploadFile = File(...)):
    """Upload an image/PDF and immediately start processing it."""
    result = await upload_image(file)
    job_id = result["job_id"]
    _start_pipeline(job_id)
    return {"job_id": job_id, "filename": result["filename"], "status": "queued", "page_count": result.get("page_count", 1)}


@app.get("/api/status/{job_id}")
async def get_status(job_id: str):
    """Get the processing status of a job."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    return {
        "job_id": job_id,
        "status": job["status"],
        "image_name": job["image_name"],
        "duration": job.get("duration"),
        "error": job.get("error"),
    }


@app.get("/api/results/{job_id}")
async def get_results(job_id: str):
    """Get the full annotation results for a completed job."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != JobStatus.DONE:
        raise HTTPException(400, f"Job status is {job['status']}, not done")
    return {
        "job_id": job_id,
        "image_name": job["image_name"],
        "duration": job["duration"],
        "annotation": job["annotation"],
    }


@app.patch("/api/results/{job_id}/cells")
async def edit_cell(job_id: str, payload: CellEditRequest):
    """Edit a cell's text in the annotation (preview/edit feature)."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != JobStatus.DONE:
        raise HTTPException(400, "Job not done yet")

    annotation = job["annotation"]
    for table in annotation.get("tables", []):
        if table["table_id"] == payload.table_id:
            for cell in table.get("cells", []):
                if cell["row"] == payload.row and cell["col"] == payload.col:
                    cell["text"] = payload.text
                    return {"ok": True, "table_id": payload.table_id, "row": payload.row, "col": payload.col, "text": payload.text}
            raise HTTPException(404, f"Cell ({payload.row}, {payload.col}) not found in table {payload.table_id}")
    raise HTTPException(404, f"Table {payload.table_id} not found")


@app.get("/api/image/{job_id}")
async def get_image(job_id: str):
    """Serve the original uploaded image (or first page for PDFs)."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    image_path = Path(jobs[job_id]["image_path"])
    if not image_path.exists():
        raise HTTPException(404, "Image file not found")
    return FileResponse(image_path, media_type="image/png")


@app.get("/api/table-crop/{job_id}/{table_id}")
async def get_table_crop(job_id: str, table_id: int):
    """Serve a cropped table image."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job_dir = Path(jobs[job_id]["image_path"]).parent
    crop_path = job_dir / f"table_{table_id}.png"
    if not crop_path.exists():
        raise HTTPException(404, f"Table crop {table_id} not found")
    return FileResponse(crop_path, media_type="image/png", filename=f"table_{table_id}.png")


@app.get("/api/table-crops/{job_id}")
async def get_table_crops_zip(job_id: str):
    """Download all table crops as a ZIP file."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    job_dir = Path(job["image_path"]).parent

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for crop_file in sorted(job_dir.glob("table_*.png")):
            zf.write(crop_file, crop_file.name)
    buf.seek(0)

    stem = Path(job["image_name"]).stem
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{stem}_table_crops.zip"'},
    )


@app.get("/api/export/{job_id}")
async def export_results(job_id: str, format: str = "json"):
    """Export results in various formats."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != JobStatus.DONE:
        raise HTTPException(400, "Job not done yet")

    annotation = job["annotation"]
    stem = Path(job["image_name"]).stem

    from export import export_csv_all, export_excel, export_html, export_json

    if format == "json":
        content = export_json(annotation)
        return StreamingResponse(
            io.BytesIO(content.encode("utf-8")),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{stem}.json"'},
        )
    elif format == "html":
        content = export_html(annotation)
        return StreamingResponse(
            io.BytesIO(content.encode("utf-8")),
            media_type="text/html",
            headers={"Content-Disposition": f'attachment; filename="{stem}.html"'},
        )
    elif format == "csv":
        content = export_csv_all(annotation)
        if not content:
            raise HTTPException(400, "No tables in annotation")
        return StreamingResponse(
            io.BytesIO(content.encode("utf-8")),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'},
        )
    elif format == "xlsx":
        tmp_path = UPLOAD_DIR / f"{job_id}_{stem}.xlsx"
        export_excel(annotation, str(tmp_path))
        return FileResponse(
            tmp_path,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=f"{stem}.xlsx",
        )
    else:
        raise HTTPException(400, f"Unsupported format: {format}")


@app.get("/api/jobs")
async def list_jobs():
    """List all jobs with their status."""
    return [
        {
            "job_id": j["id"],
            "status": j["status"],
            "image_name": j["image_name"],
            "duration": j.get("duration"),
        }
        for j in sorted(jobs.values(), key=lambda x: x["created_at"], reverse=True)
    ]


# ---------------------------------------------------------------------------
# Health Monitoring API
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def get_health():
    """Return aggregated health metrics for the monitoring dashboard."""
    import statistics

    with _health_lock:
        total = _health_metrics["total_jobs"]
        success = _health_metrics["successful_jobs"]
        failed = _health_metrics["failed_jobs"]
        latencies = [entry["duration"] for entry in _health_metrics["latencies"]]
        recent_errors = list(_health_metrics["recent_errors"])

    uptime = time.time() - _server_start_time
    success_rate = round(success / total * 100, 1) if total > 0 else 0.0
    failure_rate = round(failed / total * 100, 1) if total > 0 else 0.0

    lat_stats = {}
    if latencies:
        sorted_lat = sorted(latencies)
        lat_stats = {
            "avg": round(statistics.mean(sorted_lat), 2),
            "min": round(sorted_lat[0], 2),
            "max": round(sorted_lat[-1], 2),
            "p50": round(sorted_lat[len(sorted_lat) // 2], 2),
            "p95": round(sorted_lat[int(len(sorted_lat) * 0.95)], 2) if len(sorted_lat) >= 2 else round(sorted_lat[-1], 2),
        }

    return {
        "uptime_seconds": round(uptime, 0),
        "total_jobs": total,
        "successful_jobs": success,
        "failed_jobs": failed,
        "success_rate": success_rate,
        "failure_rate": failure_rate,
        "latency": lat_stats,
        "recent_errors": recent_errors[-10:],
        "active_jobs": sum(1 for j in jobs.values() if j["status"] in (JobStatus.QUEUED, JobStatus.PROCESSING)),
    }


# ---------------------------------------------------------------------------
# Serve React frontend (production build)
# ---------------------------------------------------------------------------

_WEB_DIST = Path(__file__).parent / "web" / "dist"
if _WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(_WEB_DIST / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the React SPA — all non-API routes go to index.html."""
        file_path = _WEB_DIST / full_path
        if full_path and file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_WEB_DIST / "index.html")
else:
    @app.get("/")
    async def root():
        return HTMLResponse(
            "<h1>Ag27 — Table Extractor API</h1>"
            "<p>Frontend not built yet. Run <code>cd web && npm run build</code></p>"
            "<p><a href='/docs'>API Docs</a></p>"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
