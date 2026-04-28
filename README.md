# Ag27 Table Extraction

Ag27 is a local document table extraction app. It combines table detection, table structure recognition, OCR, and cell assignment into one pipeline, then exposes the output through a FastAPI backend and a React web interface.

The app has two main tools:

- **Extractor**: upload document images, run the extraction pipeline, review detected tables, and export results.
- **Label Editor**: inspect and edit COCO-style dataset annotations for table-structure labels.

## Features

- Detects tables in page images.
- Recovers rows, columns, column headers, projected row headers, spanning cells, and final cell boxes.
- Runs OCR and assigns recognized text back to table cells.
- Exports extracted results as JSON, HTML, CSV, or XLSX.
- Serves a browser UI for upload, processing, preview, and export.
- Includes a dataset label editor for reviewing and correcting bounding boxes.

## Project Layout

```text
.
|-- pipeline.py                  # 5-phase extraction pipeline
|-- server.py                    # FastAPI API and production web server
|-- export.py                    # JSON, HTML, CSV, and XLSX exporters
|-- convert_models_to_onnx.py    # Utility for model conversion
|-- pyproject.toml               # Python dependencies for uv
|-- requirements.txt             # Minimal legacy dependency list
|-- Dockerfile                   # Pipeline container entrypoint
|-- TATR_TD/                     # Table detection model files
|-- TableStructureRecognition/   # Table structure model files
|-- ocr_models/                  # OCR ONNX models and dictionary
`-- web/                         # Vite + React frontend
```

## Requirements

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/) for Python environment management
- Node.js and npm for the React frontend
- Model files in:
  - `TATR_TD/`
  - `TableStructureRecognition/`
  - `ocr_models/`

GPU execution requires a working CUDA/PyTorch/ONNX Runtime GPU setup. CPU mode is supported and is easier for local testing, but it is slower.

## Quick Start: Web App

Run these commands from the project root.

### 1. Install Python dependencies

```powershell
uv sync
```

Use `uv sync` instead of `pip install -r requirements.txt` for the web app, because `pyproject.toml` includes the FastAPI, Uvicorn, multipart upload, and frontend-serving dependencies.

### 2. Point the pipeline at the local model folders

PowerShell:

```powershell
$env:TD_MODEL_DIR = "$PWD\TATR_TD"
$env:TSR_MODEL_DIR = "$PWD\TableStructureRecognition"
$env:OCR_MODEL_DIR = "$PWD\ocr_models"
```

Bash:

```bash
export TD_MODEL_DIR="$PWD/TATR_TD"
export TSR_MODEL_DIR="$PWD/TableStructureRecognition"
export OCR_MODEL_DIR="$PWD/ocr_models"
```

### 3. Optional: force CPU mode

PowerShell:

```powershell
$env:PIPELINE_DEVICE = "cpu"
```

Bash:

```bash
export PIPELINE_DEVICE=cpu
```

Skip this step if you want the pipeline to use GPU when available.

### 4. Build the frontend

PowerShell:

```powershell
cd web
npm.cmd install
npm.cmd run build
cd ..
```

Bash:

```bash
cd web
npm install
npm run build
cd ..
```

### 5. Start the server

```powershell
uv run python server.py
```

Open the app at:

```text
http://localhost:8000
```

Swagger API docs are available at:

```text
http://localhost:8000/docs
```

## Run The Pipeline Directly

PowerShell:

```powershell
$env:TD_MODEL_DIR = "$PWD\TATR_TD"
$env:TSR_MODEL_DIR = "$PWD\TableStructureRecognition"
$env:OCR_MODEL_DIR = "$PWD\ocr_models"
$env:PIPELINE_DEVICE = "cpu"
uv run python pipeline.py path\to\image.png
```

Bash:

```bash
export TD_MODEL_DIR="$PWD/TATR_TD"
export TSR_MODEL_DIR="$PWD/TableStructureRecognition"
export OCR_MODEL_DIR="$PWD/ocr_models"
export PIPELINE_DEVICE=cpu
uv run python pipeline.py path/to/image.png
```

The pipeline writes an annotation file next to the source image:

```text
<image_stem>_annotation.json
```

## Label Editor Dataset

The Label Editor expects a COCO-style annotation file and matching image directory. By default, the server looks for:

```text
Phase3/Phase3_labels.json
Phase3/Images/
```

If your dataset is stored elsewhere, set these environment variables before starting the server.

PowerShell:

```powershell
$env:EDITOR_DATASET_PATH = "C:\path\to\Phase3_labels.json"
$env:EDITOR_IMAGES_DIR = "C:\path\to\Images"
```

Bash:

```bash
export EDITOR_DATASET_PATH="/path/to/Phase3_labels.json"
export EDITOR_IMAGES_DIR="/path/to/Images"
```

When saving labels, the server creates a one-time backup next to the dataset:

```text
Phase3_labels.backup.json
```

## API Endpoints

### Extraction

- `POST /api/upload`
- `POST /api/process/{job_id}`
- `POST /api/upload-and-process`
- `GET /api/status/{job_id}`
- `GET /api/results/{job_id}`
- `GET /api/image/{job_id}`
- `GET /api/export/{job_id}?format=json|html|csv|xlsx`
- `GET /api/jobs`

### Label Editor

- `GET /api/editor/meta`
- `GET /api/editor/image/{image_id}`
- `GET /api/editor/assets/{file_name}`
- `POST /api/editor/image/{image_id}`

## Export Formats

- **JSON**: full pipeline annotation object.
- **HTML**: one HTML table per detected table.
- **CSV**: first detected table as CSV.
- **XLSX**: one Excel sheet per detected table.

## Useful Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `TD_MODEL_DIR` | Table detection model directory | `A:\Ag27\TATR_TD` |
| `TSR_MODEL_DIR` | Table structure model directory | `A:\Ag27\TableStructureDetection` |
| `OCR_MODEL_DIR` | OCR model directory | `A:\Ag27\ocr_models` |
| `PIPELINE_DEVICE` | Set to `cpu` to force CPU execution | auto/GPU-capable behavior |
| `UPLOAD_DIR` | Uploaded image and export temp directory | `./uploads` |
| `EDITOR_DATASET_PATH` | Label editor annotation JSON | `Phase3/Phase3_labels.json` |
| `EDITOR_IMAGES_DIR` | Label editor image directory | `Phase3/Images` |
| `PREWARM_PIPELINE_ON_STARTUP` | Load pipeline runtimes during server startup | disabled |

## Development Commands

Frontend development server:

```powershell
cd web
npm.cmd run dev
```

Frontend production build:

```powershell
cd web
npm.cmd run build
```

Frontend lint:

```powershell
cd web
npm.cmd run lint
```

Python syntax check:

```powershell
python -m py_compile server.py export.py pipeline.py convert_models_to_onnx.py
```

## Troubleshooting

### `npm` is blocked by PowerShell execution policy

Use `npm.cmd` instead of `npm`:

```powershell
npm.cmd install
npm.cmd run build
```

### Model folders are not found

Set the model directory environment variables before running the server:

```powershell
$env:TD_MODEL_DIR = "$PWD\TATR_TD"
$env:TSR_MODEL_DIR = "$PWD\TableStructureRecognition"
$env:OCR_MODEL_DIR = "$PWD\ocr_models"
```

### The Label Editor shows a dataset error

Set `EDITOR_DATASET_PATH` and `EDITOR_IMAGES_DIR` to your dataset locations, or place the dataset at the default `Phase3/` paths.

### CPU execution is slow

This is expected. Remove `PIPELINE_DEVICE=cpu` and use a CUDA-capable environment for faster inference.

## Notes

- Jobs are stored in memory, so they are lost when the FastAPI process restarts.
- Pipeline calls are serialized with a lock to avoid GPU/VRAM contention.
- `web/README.md` is the default Vite template and does not describe this app.
