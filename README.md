# Ag27

Ag27 extracts tables from document images. It combines table detection, table structure recognition, OCR, and cell assignment into a single local pipeline, then exposes the results through a FastAPI backend and a React web UI.

## What It Does

- Detects tables in page images.
- Recovers rows, columns, spanning cells, and cell boundaries.
- Runs OCR over each table and assigns text back to cells.
- Exports results as JSON, HTML, CSV, or Excel.
- Serves a browser UI for upload, processing, and review.

## Layout

- `pipeline.py` runs the 5-phase extraction pipeline.
- `server.py` exposes the API and serves the built web app.
- `export.py` handles JSON, HTML, CSV, and Excel output.
- `web/` contains the Vite React frontend.
- `Annotated_GroundTruth/images/` contains sample inputs.
- `TATR_TD/`, `TableStructureRecognition/model35/`, and `ocr_models/` hold the local model files.

## Run The Web App

The web UI is served by the FastAPI app after the frontend is built.

```bash
uv sync
cd web && npm install && npm run build && cd ..
uv run python server.py
```

Open `http://localhost:8000` in a browser.

If you want a CPU-only run on this machine:

```bash
PIPELINE_DEVICE=cpu uv run python server.py
```

## Run The Pipeline Directly

```bash
PIPELINE_DEVICE=cpu uv run python pipeline.py Annotated_GroundTruth/images/PMC3651089_2.jpg
```

That command writes `<image_stem>_annotation.json` next to the source image.

## API

- `POST /api/upload`
- `POST /api/process/{job_id}`
- `POST /api/upload-and-process`
- `GET /api/status/{job_id}`
- `GET /api/results/{job_id}`
- `GET /api/image/{job_id}`
- `GET /api/export/{job_id}?format=json|html|csv|xlsx`
- `GET /api/jobs`

Swagger docs are available at `http://localhost:8000/docs`.

## Notes

- `web/README.md` is the default Vite template and does not describe this app.
- On NixOS, the pipeline may need the `LD_LIBRARY_PATH` bootstrap described in `NEXT_AGENT_RUNBOOK.md`.
- The repository includes benchmark scripts for timing different stages of the pipeline.
