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

EDITOR_DATASET_PATH = Path(os.environ.get("EDITOR_DATASET_PATH", "Phase3/Phase3_labels.json"))
EDITOR_IMAGES_DIR = Path(os.environ.get("EDITOR_IMAGES_DIR", str(EDITOR_DATASET_PATH.parent / "Images")))
_editor_lock = threading.Lock()


class EditorAnnotationPayload(BaseModel):
    id: int | None = None
    image_id: int | None = None
    category_id: int
    bbox: list[float] = Field(min_length=4, max_length=4)
    iscrowd: int = 0
    ignore: int = 0


class EditorSaveRequest(BaseModel):
    annotations: list[EditorAnnotationPayload]


def _ensure_editor_dataset_exists() -> None:
    if not EDITOR_DATASET_PATH.exists():
        raise HTTPException(404, f"Editor dataset not found: {EDITOR_DATASET_PATH}")
    if not EDITOR_IMAGES_DIR.exists():
        raise HTTPException(404, f"Editor images directory not found: {EDITOR_IMAGES_DIR}")


def _load_editor_dataset() -> dict[str, Any]:
    _ensure_editor_dataset_exists()
    return json.loads(EDITOR_DATASET_PATH.read_text(encoding="utf-8"))


def _write_editor_dataset(payload: dict[str, Any]) -> None:
    backup_path = EDITOR_DATASET_PATH.with_name(f"{EDITOR_DATASET_PATH.stem}.backup{EDITOR_DATASET_PATH.suffix}")
    if not backup_path.exists():
        shutil.copy2(EDITOR_DATASET_PATH, backup_path)

    temp_path = EDITOR_DATASET_PATH.with_suffix(f"{EDITOR_DATASET_PATH.suffix}.tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(EDITOR_DATASET_PATH)


def _editor_indexes(dataset: dict[str, Any]) -> tuple[dict[int, dict[str, Any]], dict[int, dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    images_by_id = {int(image["id"]): image for image in dataset.get("images", [])}
    categories_by_id = {int(category["id"]): category for category in dataset.get("categories", [])}
    annotations_by_image: dict[int, list[dict[str, Any]]] = {}
    for annotation in dataset.get("annotations", []):
        annotations_by_image.setdefault(int(annotation["image_id"]), []).append(annotation)
    return images_by_id, categories_by_id, annotations_by_image


def _normalize_bbox(bbox: list[float], width: float, height: float) -> list[float]:
    x, y, w, h = [float(value) for value in bbox]
    if w < 0:
        x += w
        w = abs(w)
    if h < 0:
        y += h
        h = abs(h)
    x = max(0.0, min(x, width))
    y = max(0.0, min(y, height))
    w = max(1.0, min(w, max(1.0, width - x)))
    h = max(1.0, min(h, max(1.0, height - y)))
    return [round(x, 2), round(y, 2), round(w, 2), round(h, 2)]


def _serialize_editor_annotation(annotation: dict[str, Any], category_name: str) -> dict[str, Any]:
    bbox = [round(float(value), 2) for value in annotation.get("bbox", [0, 0, 0, 0])]
    return {
        "id": int(annotation["id"]),
        "image_id": int(annotation["image_id"]),
        "category_id": int(annotation["category_id"]),
        "category_name": category_name,
        "bbox": bbox,
        "area": round(float(annotation.get("area", bbox[2] * bbox[3])), 2),
        "iscrowd": int(annotation.get("iscrowd", 0)),
        "ignore": int(annotation.get("ignore", 0)),
    }

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
    image_path = job["image_path"]

    logger.info("Starting pipeline for job %s (%s)", job_id, image_path)

    try:
        # Serialize pipeline calls to avoid VRAM contention
        with _pipeline_lock:
            from pipeline import run_pipeline
            annotation = run_pipeline(image_path)

        job["annotation"] = annotation
        job["status"] = JobStatus.DONE
        job["finished_at"] = time.time()
        job["duration"] = round(job["finished_at"] - job["started_at"], 2)
        logger.info("Job %s done in %.1fs", job_id, job["duration"])
    except Exception as e:
        logger.exception("Job %s failed", job_id)
        job["status"] = JobStatus.ERROR
        job["error"] = str(e)
        job["finished_at"] = time.time()


def _start_pipeline(job_id: str):
    """Start the pipeline in a background thread."""
    t = threading.Thread(target=_run_pipeline_thread, args=(job_id,), daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)):
    """Upload an image and get a job_id back."""
    ext = Path(file.filename or "image.jpg").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif"}:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())[:12]
    job_dir = UPLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Preserve original filename
    safe_name = (file.filename or f"image{ext}").replace(" ", "_")
    dest = job_dir / safe_name
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    jobs[job_id] = {
        "id": job_id,
        "status": JobStatus.QUEUED,
        "image_path": str(dest),
        "image_name": safe_name,
        "annotation": None,
        "error": None,
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "duration": None,
    }

    return {"job_id": job_id, "filename": safe_name}


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
    """Upload an image and immediately start processing it."""
    result = await upload_image(file)
    job_id = result["job_id"]
    _start_pipeline(job_id)
    return {"job_id": job_id, "filename": result["filename"], "status": "queued"}


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


@app.get("/api/image/{job_id}")
async def get_image(job_id: str):
    """Serve the original uploaded image."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    image_path = Path(jobs[job_id]["image_path"])
    if not image_path.exists():
        raise HTTPException(404, "Image file not found")
    return FileResponse(image_path, media_type="image/jpeg")


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

    from export import export_csv, export_excel, export_html, export_json

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
        tables = annotation.get("tables", [])
        if not tables:
            raise HTTPException(400, "No tables in annotation")
        content = export_csv(annotation, tables[0]["table_id"])
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


@app.get("/api/editor/meta")
async def get_editor_meta():
    with _editor_lock:
        dataset = _load_editor_dataset()
        images_by_id, categories_by_id, annotations_by_image = _editor_indexes(dataset)

        images = []
        for image in dataset.get("images", []):
            image_id = int(image["id"])
            annotations = annotations_by_image.get(image_id, [])
            counts: dict[str, int] = {}
            for annotation in annotations:
                category_name = categories_by_id.get(int(annotation["category_id"]), {}).get("name", "unknown")
                counts[category_name] = counts.get(category_name, 0) + 1
            images.append(
                {
                    "id": image_id,
                    "file_name": image["file_name"],
                    "width": int(image["width"]),
                    "height": int(image["height"]),
                    "annotation_count": len(annotations),
                    "counts_by_category": counts,
                }
            )

        return {
            "dataset_path": str(EDITOR_DATASET_PATH),
            "images_dir": str(EDITOR_IMAGES_DIR),
            "image_count": len(images_by_id),
            "annotation_count": len(dataset.get("annotations", [])),
            "categories": dataset.get("categories", []),
            "images": images,
        }


@app.get("/api/editor/image/{image_id}")
async def get_editor_image(image_id: int):
    with _editor_lock:
        dataset = _load_editor_dataset()
        images_by_id, categories_by_id, annotations_by_image = _editor_indexes(dataset)
        image = images_by_id.get(image_id)
        if not image:
            raise HTTPException(404, f"Image id {image_id} not found in editor dataset")

        annotations = [
            _serialize_editor_annotation(
                annotation,
                categories_by_id.get(int(annotation["category_id"]), {}).get("name", "unknown"),
            )
            for annotation in annotations_by_image.get(image_id, [])
        ]
        annotations.sort(key=lambda item: (item["category_id"], item["id"]))

        image_path = EDITOR_IMAGES_DIR / str(image["file_name"])
        if not image_path.exists():
            raise HTTPException(404, f"Image file not found: {image_path}")

        return {
            "image": {
                "id": int(image["id"]),
                "file_name": image["file_name"],
                "width": int(image["width"]),
                "height": int(image["height"]),
                "image_url": f"/api/editor/assets/{image['file_name']}",
            },
            "annotations": annotations,
        }


@app.get("/api/editor/assets/{file_name:path}")
async def get_editor_asset(file_name: str):
    image_path = EDITOR_IMAGES_DIR / file_name
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(404, f"Image file not found: {image_path}")
    return FileResponse(image_path)


@app.post("/api/editor/image/{image_id}")
async def save_editor_image(image_id: int, payload: EditorSaveRequest):
    with _editor_lock:
        dataset = _load_editor_dataset()
        images_by_id, categories_by_id, _ = _editor_indexes(dataset)
        image = images_by_id.get(image_id)
        if not image:
            raise HTTPException(404, f"Image id {image_id} not found in editor dataset")

        valid_category_ids = set(categories_by_id)
        width = float(image["width"])
        height = float(image["height"])
        next_annotation_id = max((int(item["id"]) for item in dataset.get("annotations", [])), default=0) + 1

        saved_annotations: list[dict[str, Any]] = []
        seen_ids: set[int] = set()
        for item in payload.annotations:
            if int(item.category_id) not in valid_category_ids:
                raise HTTPException(400, f"Unknown category id: {item.category_id}")

            normalized_bbox = _normalize_bbox(item.bbox, width=width, height=height)
            annotation_id = int(item.id) if item.id is not None else next_annotation_id
            if item.id is None:
                next_annotation_id += 1
            if annotation_id in seen_ids:
                raise HTTPException(400, f"Duplicate annotation id in payload: {annotation_id}")
            seen_ids.add(annotation_id)

            saved_annotations.append(
                {
                    "id": annotation_id,
                    "image_id": image_id,
                    "category_id": int(item.category_id),
                    "bbox": normalized_bbox,
                    "area": round(normalized_bbox[2] * normalized_bbox[3], 2),
                    "iscrowd": int(item.iscrowd),
                    "ignore": int(item.ignore),
                }
            )

        preserved_annotations = [
            annotation
            for annotation in dataset.get("annotations", [])
            if int(annotation["image_id"]) != image_id
        ]
        dataset["annotations"] = preserved_annotations + saved_annotations
        dataset["annotations"].sort(key=lambda item: (int(item["image_id"]), int(item["id"])))
        _write_editor_dataset(dataset)

        return {
            "ok": True,
            "image_id": image_id,
            "saved_count": len(saved_annotations),
            "annotations": [
                _serialize_editor_annotation(
                    annotation,
                    categories_by_id[int(annotation["category_id"])]["name"],
                )
                for annotation in saved_annotations
            ],
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
