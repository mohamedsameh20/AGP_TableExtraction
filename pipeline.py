"""Table Extraction Pipeline — 5-phase inference system.

Ported from the competition notebook (colabNB.py) to run locally.
Phases (execution order, grouped by runtime to avoid VRAM contention):
  1. Table Detection        (PyTorch / HuggingFace TableTransformer)
  4. Table Structure Recog. (PyTorch / HuggingFace TableTransformer)
     [unload PyTorch, free VRAM]
  2+3. Text Detection + Recognition  (RapidOCR / PaddleOCR v5 ONNX)
  5. Cell Assignment         (pure Python)
"""
from __future__ import annotations

import gc
from functools import lru_cache
import json
import logging
import os
import sys
import ctypes
from time import perf_counter
from collections.abc import Sequence as _Seq
from dataclasses import dataclass, field, replace
from numbers import Real as _Real
from pathlib import Path
from typing import Any, Tuple


def _bootstrap_cuda_driver() -> None:
    """Prefer the real NVIDIA driver library on Linux/NixOS.

    On NixOS, CUDA-enabled wheels can accidentally resolve a stub libcuda from the
    Python environment instead of the host driver, which causes provider init
    failures. Preloading /run/opengl-driver/lib/libcuda.so.1 pins resolution to
    the real driver for this process.
    """
    if sys.platform != "linux":
        return

    candidates: list[Path] = []
    env_path = os.environ.get("CUDA_DRIVER_LIB_PATH")
    if env_path:
        candidates.append(Path(env_path))
    candidates.append(Path("/run/opengl-driver/lib/libcuda.so.1"))

    for libcuda_path in candidates:
        if not libcuda_path.exists():
            continue
        try:
            # Keep symbols globally visible for downstream CUDA consumers.
            ctypes.CDLL(str(libcuda_path), mode=getattr(ctypes, "RTLD_GLOBAL", 0))
            break
        except OSError:
            continue


_bootstrap_cuda_driver()

import cv2
import numpy as np
import torch
import onnxruntime as ort
from PIL import Image
from rapidocr_onnxruntime import RapidOCR
from torchvision.ops import batched_nms
from transformers import AutoImageProcessor, TableTransformerConfig, TableTransformerForObjectDetection

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths (overridable via environment variables for containerisation)
# ---------------------------------------------------------------------------
TD_MODEL_DIR  = Path(os.environ.get("TD_MODEL_DIR",  r"A:\Ag27\TATR_TD"))
TSR_MODEL_DIR = Path(os.environ.get("TSR_MODEL_DIR", r"A:\Ag27\TableStructureDetection"))
OCR_MODEL_DIR = Path(os.environ.get("OCR_MODEL_DIR", r"A:\Ag27\ocr_models"))
DET_MODEL_PATH = OCR_MODEL_DIR / "texdet.onnx"
REC_MODEL_PATH = OCR_MODEL_DIR / "textrec.onnx"
DICT_PATH      = OCR_MODEL_DIR / "dictionary.txt"

# ---------------------------------------------------------------------------
# Thresholds & constants
# ---------------------------------------------------------------------------
TD_CONF_THRESHOLD       = 0.75
TD_NMS_IOU              = 0.5
TSR_CONF_THRESHOLD      = 0.5
TSR_NMS_IOU             = 0.35
PADDING_PCT             = 0.02
TSR_SPAN_OVERLAP_THRESH = 0.25
CELL_OCR_SCORE_THRESHOLD = 0.35
OCR_REC_BATCH_NUM       = max(1, int(os.environ.get("OCR_REC_BATCH_NUM", "32")))
OCR_DET_LIMIT_SIDE_LEN  = max(32, int(os.environ.get("OCR_DET_LIMIT_SIDE_LEN", "960")))
OCR_DET_LIMIT_TYPE      = os.environ.get("OCR_DET_LIMIT_TYPE", "max")
OCR_CELL_CROP_MARGIN    = max(0, int(os.environ.get("OCR_CELL_CROP_MARGIN", "8")))
OCR_ASSIGN_MIN_IOA      = float(os.environ.get("OCR_ASSIGN_MIN_IOA", "0.35"))
OCR_ASSIGN_MIN_IOU      = float(os.environ.get("OCR_ASSIGN_MIN_IOU", "0.02"))
OCR_ASSIGN_NEAREST_MAX  = float(os.environ.get("OCR_ASSIGN_NEAREST_MAX", "0.60"))
OCR_ASSIGN_USE_CENTER   = os.environ.get("OCR_ASSIGN_USE_CENTER", "1").strip().lower() not in {"0", "false", "no", "off"}
OCR_ASSIGN_USE_NEAREST  = os.environ.get("OCR_ASSIGN_USE_NEAREST", "1").strip().lower() not in {"0", "false", "no", "off"}
TSR_ENABLE_LEFT_SPANNER = os.environ.get("TSR_ENABLE_LEFT_SPANNER", "1").strip().lower() not in {"0", "false", "no", "off"}
TSR_LEFT_SPANNER_MIN_SCORE = float(os.environ.get("TSR_LEFT_SPANNER_MIN_SCORE", "0.35"))
TSR_LEFT_SPANNER_MIN_FILL_RATIO = float(os.environ.get("TSR_LEFT_SPANNER_MIN_FILL_RATIO", "0.98"))
PIPELINE_DEBUG_HEURISTICS = os.environ.get("PIPELINE_DEBUG_HEURISTICS", "0").strip().lower() not in {"0", "false", "no", "off"}

STRUCTURE_LABELS = {
    1: "table column",
    2: "table row",
    3: "table column header",
    4: "table projected row header",
    5: "table spanning cell",
}
STRUCTURE_COLUMN_LABELS = {"table column"}
STRUCTURE_ROW_LABELS = {"table row"}
STRUCTURE_SPAN_LABELS = {"table projected row header", "table spanning cell", "span_like"}


def _normalize_structure_label_name(name):
    return str(name).strip().lower().replace("_", " ").replace("-", " ")


def _resolve_structure_label_name(label_id, label_map=None):
    if label_map:
        raw_name = label_map.get(int(label_id))
        if raw_name is not None:
            normalized = _normalize_structure_label_name(raw_name)
            if normalized == "span like":
                return "span_like"
            return normalized
    return STRUCTURE_LABELS.get(int(label_id), str(int(label_id)))

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
BBox = Tuple[float, float, float, float]


@dataclass(frozen=True)
class Detection:
    label: str
    bbox: BBox
    score: float | None = None
    source: str = "prediction"
    table_id: int | None = None
    extra: dict = field(default_factory=dict)


@dataclass(frozen=True)
class CellPrediction:
    bbox: BBox
    row: int
    col: int
    table_id: int
    row_span: int = 1
    col_span: int = 1
    text: str = ""
    ocr_score: float | None = None
    extra: dict = field(default_factory=dict)


@dataclass(frozen=True)
class TableGrid:
    cells: list[CellPrediction]
    row_bounds: tuple[float, ...]
    col_bounds: tuple[float, ...]
    notes: tuple[str, ...] = ()


# ═══════════════════════════════════════════════════════════════════════════
# Model loading (matches notebook config overrides)
# ═══════════════════════════════════════════════════════════════════════════

def load_td_model(model_dir, providers=None):
    model_dir = Path(model_dir)
    processor = AutoImageProcessor.from_pretrained(model_dir, use_fast=False)

    # TD config may contain backbone fields that are not loadable in local setups.
    with open(model_dir / "config.json", "r") as f:
        cfg = json.load(f)
    cfg.pop("backbone_config", None)
    cfg["backbone"] = "resnet18"
    cfg["use_timm_backbone"] = True
    config = TableTransformerConfig.from_dict(cfg)

    model = TableTransformerForObjectDetection.from_pretrained(
        model_dir,
        config=config,
        ignore_mismatched_sizes=True,
    )
    device = _torch_runtime_device()
    model = model.to(device)
    model.eval()
    model._runtime_device = device

    return processor, model


def load_tsr_model(model_dir, providers=None):
    model_dir = Path(model_dir)
    processor = AutoImageProcessor.from_pretrained(model_dir, use_fast=False)

    config = TableTransformerConfig.from_pretrained(model_dir)
    config.backbone = None
    model = TableTransformerForObjectDetection.from_pretrained(
        model_dir,
        config=config,
        ignore_mismatched_sizes=True,
    )
    device = _torch_runtime_device()
    model = model.to(device)
    model.eval()
    model._runtime_device = device

    return processor, model


@lru_cache(maxsize=4)
def _get_td_runtime(providers_key: tuple[str, ...]):
    return load_td_model(TD_MODEL_DIR, list(providers_key))


@lru_cache(maxsize=4)
def _get_tsr_runtime(providers_key: tuple[str, ...]):
    return load_tsr_model(TSR_MODEL_DIR, list(providers_key))


def _env_flag(name: str, default: bool | None = None) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    raw = raw.strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _pipeline_device_mode() -> str:
    """Return runtime device mode: cpu (default), cuda, or auto."""
    raw = os.environ.get("PIPELINE_DEVICE", "cpu").strip().lower()
    if raw in {"cpu", "cuda", "auto"}:
        return raw
    return "cpu"


def _is_cpu_only_runtime() -> bool:
    mode = _pipeline_device_mode()
    if mode == "cpu":
        return True
    if mode == "auto":
        return not torch.cuda.is_available()
    return False


def _torch_runtime_device() -> torch.device:
    if _is_cpu_only_runtime():
        return torch.device("cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _ocr_cuda_enabled():
    if _is_cpu_only_runtime():
        return False
    requested = _env_flag("OCR_USE_CUDA")
    if requested is not None:
        return requested
    # Avoid selecting CUDA for OCR when the runtime cannot actually use a GPU.
    if not torch.cuda.is_available():
        return False
    return "CUDAExecutionProvider" in ort.get_available_providers()


def _cache_gpu_runtimes():
    return _env_flag("CACHE_GPU_RUNTIMES", True) is not False


def _warmup_ocr_on_create():
    return _env_flag("OCR_WARMUP_ON_CREATE", True) is not False


def _selected_providers():
    if _is_cpu_only_runtime():
        return ["CPUExecutionProvider"]
    return ["CUDAExecutionProvider", "CPUExecutionProvider"] if torch.cuda.is_available() else ["CPUExecutionProvider"]


def _warmup_ocr_engine(engine):
    if not _warmup_ocr_on_create():
        return engine
    warmup_h = max(32, int(os.environ.get("OCR_WARMUP_HEIGHT", "64")))
    warmup_w = max(32, int(os.environ.get("OCR_WARMUP_WIDTH", "256")))
    warmup_image = np.zeros((warmup_h, warmup_w, 3), dtype=np.uint8)
    start = perf_counter()
    engine(warmup_image, use_cls=False)
    logger.info(
        "RapidOCR warmup complete in %.3fs on %dx%d dummy image",
        perf_counter() - start,
        warmup_w,
        warmup_h,
    )
    return engine


@lru_cache(maxsize=2)
def _get_ocr_engine(use_cuda: bool):
    return _create_ocr_engine(use_cuda=use_cuda)


def _create_ocr_engine(use_cuda: bool | None = None):
    if use_cuda is None:
        use_cuda = _ocr_cuda_enabled()
    base_kwargs = {
        "det_model_path": str(DET_MODEL_PATH),
        "rec_model_path": str(REC_MODEL_PATH),
        "rec_keys_path": str(DICT_PATH),
        "use_cls": False,
    }
    tuned_kwargs = {
        **base_kwargs,
        "rec_batch_num": OCR_REC_BATCH_NUM,
        "det_limit_side_len": OCR_DET_LIMIT_SIDE_LEN,
        "det_limit_type": OCR_DET_LIMIT_TYPE,
        "print_verbose": False,
    }
    if use_cuda:
        tuned_kwargs.update(
            det_use_cuda=True,
            rec_use_cuda=True,
            cls_use_cuda=False,
        )
    try:
        engine = RapidOCR(**tuned_kwargs)
        logger.info(
            "RapidOCR initialized (cuda=%s, rec_batch_num=%d, det_limit_side_len=%d, det_limit_type=%s)",
            use_cuda,
            OCR_REC_BATCH_NUM,
            OCR_DET_LIMIT_SIDE_LEN,
            OCR_DET_LIMIT_TYPE,
        )
        return _warmup_ocr_engine(engine)
    except TypeError:
        logger.warning("RapidOCR does not support the tuned OCR kwargs in this environment; falling back to basic initialization.")
    return _warmup_ocr_engine(
        RapidOCR(
            det_model_path=str(DET_MODEL_PATH),
            rec_model_path=str(REC_MODEL_PATH),
            rec_keys_path=str(DICT_PATH),
            use_cls=False,
        )
    )


def prewarm_pipeline_runtimes():
    providers = _selected_providers()
    providers_key = tuple(providers)
    cpu_only_runtime = providers == ["CPUExecutionProvider"]
    use_cached_runtimes = cpu_only_runtime or _cache_gpu_runtimes()
    ocr_use_cuda = _ocr_cuda_enabled() and not cpu_only_runtime
    if not use_cached_runtimes:
        logger.info("Skipping runtime prewarm because CACHE_GPU_RUNTIMES is disabled.")
        return
    start = perf_counter()
    _get_td_runtime(providers_key)
    _get_tsr_runtime(providers_key)
    _get_ocr_engine(ocr_use_cuda)
    logger.info(
        "Pipeline runtime prewarm complete in %.3fs (providers=%s, ocr_cuda=%s)",
        perf_counter() - start,
        providers,
        ocr_use_cuda,
    )


# ═══════════════════════════════════════════════════════════════════════════
# Utility helpers
# ═══════════════════════════════════════════════════════════════════════════

def _clip_box(box, image_w, image_h):
    x1, y1, x2, y2 = box
    return (
        float(np.clip(x1, 0.0, float(image_w))),
        float(np.clip(y1, 0.0, float(image_h))),
        float(np.clip(x2, 0.0, float(image_w))),
        float(np.clip(y2, 0.0, float(image_h))),
    )


def _coerce_frame_box(frame_box, img_w, img_h):
    if frame_box is None:
        return (0.0, 0.0, float(img_w), float(img_h))
    x1, y1, x2, y2 = [float(v) for v in frame_box]
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    x1 = float(np.clip(x1, 0.0, float(img_w)))
    y1 = float(np.clip(y1, 0.0, float(img_h)))
    x2 = float(np.clip(x2, 0.0, float(img_w)))
    y2 = float(np.clip(y2, 0.0, float(img_h)))
    if x2 - x1 < 2.0 or y2 - y1 < 2.0:
        return (0.0, 0.0, float(img_w), float(img_h))
    return (x1, y1, x2, y2)


def _box_iou(a, b):
    xa, ya = max(a[0], b[0]), max(a[1], b[1])
    xb, yb = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, xb - xa) * max(0.0, yb - ya)
    if inter <= 0.0:
        return 0.0
    aa = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    ab = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = aa + ab - inter
    return inter / union if union > 0 else 0.0


def _batched_nms_indices(boxes, scores, labels, iou_threshold):
    kept = []
    for label in sorted({int(v) for v in labels}):
        idxs = [i for i, v in enumerate(labels) if int(v) == label]
        idxs.sort(key=lambda i: float(scores[i]), reverse=True)
        while idxs:
            cur = idxs.pop(0)
            kept.append(cur)
            idxs = [i for i in idxs if _box_iou(boxes[cur], boxes[i]) < float(iou_threshold)]
    kept.sort(key=lambda i: float(scores[i]), reverse=True)
    return kept


def crop_table_with_padding(image, box, padding_pct=0.0):
    x1, y1, x2, y2 = box[:4]
    w, h = image.size
    pad_x = (x2 - x1) * padding_pct
    pad_y = (y2 - y1) * padding_pct
    x0 = max(0, int(x1 - pad_x))
    y0 = max(0, int(y1 - pad_y))
    x1c = min(w, int(x2 + pad_x))
    y1c = min(h, int(y2 + pad_y))
    return image.crop((x0, y0, x1c, y1c)), (x0, y0)


# ═══════════════════════════════════════════════════════════════════════════
# Phase 1 — Table Detection
# ═══════════════════════════════════════════════════════════════════════════

def _postprocess_td_result(result, id2label):
    scores = result["scores"]
    labels = result["labels"]
    boxes = result["boxes"]

    keep_mask = scores >= TD_CONF_THRESHOLD
    scores, labels, boxes = scores[keep_mask], labels[keep_mask], boxes[keep_mask]

    if len(boxes) > 0:
        keep_idx = batched_nms(boxes, scores, labels, iou_threshold=TD_NMS_IOU)
        scores, labels, boxes = scores[keep_idx], labels[keep_idx], boxes[keep_idx]

    detections = []
    for score, label, box in zip(scores.tolist(), labels.tolist(), boxes.tolist()):
        label_id = int(label)
        det_box = tuple(round(v, 1) for v in box)
        detections.append(
            Detection(
                label=id2label.get(label_id, str(label_id)),
                bbox=det_box,
                score=round(float(score), 4),
                source="prediction",
                extra={"class_id": label_id},
            )
        )
    return detections


def run_td_inference(pil_image, processor, model):
    device = getattr(model, "_runtime_device", _torch_runtime_device())
    inputs = processor(images=[pil_image], return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = model(**inputs)

    target_sizes = torch.tensor([pil_image.size[::-1]], device=device)
    results = processor.post_process_object_detection(
        outputs, threshold=0.0, target_sizes=target_sizes
    )
    id2label = {int(k): v for k, v in model.config.id2label.items()}
    return _postprocess_td_result(results[0], id2label)


# ═══════════════════════════════════════════════════════════════════════════
# Phase 4 — Table Structure Recognition (PreciseTableCellExtractor)
# ═══════════════════════════════════════════════════════════════════════════

class PreciseTableCellExtractor:
    def __init__(self, conf_thresh=0.5, nms_iou_thresh=0.3, span_overlap_thresh=0.4):
        self.conf_thresh = conf_thresh
        self.nms_iou_thresh = nms_iou_thresh
        self.span_overlap_thresh = span_overlap_thresh
        self.last_notes = ()

    def _box_area(self, box):
        return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])

    def _iou(self, a, b):
        xa, ya = max(a[0], b[0]), max(a[1], b[1])
        xb, yb = min(a[2], b[2]), min(a[3], b[3])
        inter = max(0.0, xb - xa) * max(0.0, yb - ya)
        union = self._box_area(a) + self._box_area(b) - inter
        return inter / union if union > 0 else 0.0

    def _nms(self, boxes, scores):
        if not boxes:
            return []
        idxs = np.argsort(scores)[::-1]
        keep = []
        while len(idxs) > 0:
            cur = int(idxs[0])
            keep.append(cur)
            remaining = [int(i) for i in idxs[1:] if self._iou(boxes[cur], boxes[int(i)]) < self.nms_iou_thresh]
            idxs = np.array(remaining, dtype=np.int64)
        return keep

    def _dedup_rows_by_overlap(self, rows, overlap_thresh=0.4):
        """Suppress glitch row detections that overlap vertically with neighbors.

        Standard IoU NMS fails for wide/thin row boxes.  Glitch rows are
        false detections that sit on top of real rows, creating significant
        vertical overlap.  Two real adjacent rows should have minimal overlap.
        When two consecutive rows overlap > overlap_thresh of the shorter
        row's height, the lower-scored one is dropped.
        """
        if len(rows) < 2:
            return rows
        rows = sorted(rows, key=lambda r: (r[0][1] + r[0][3]) / 2.0)
        keep = [rows[0]]
        for i in range(1, len(rows)):
            prev_box, prev_score = keep[-1]
            curr_box, curr_score = rows[i]
            # vertical overlap between adjacent row boxes
            overlap = max(0.0, prev_box[3] - curr_box[1])
            min_h = min(prev_box[3] - prev_box[1], curr_box[3] - curr_box[1])
            ratio = overlap / min_h if min_h > 0 else 0.0
            if ratio > overlap_thresh:
                # glitch — keep whichever has higher score
                if curr_score > prev_score:
                    keep[-1] = rows[i]
            else:
                keep.append(rows[i])
        return keep

    def _sanitize_box(self, box, img_w, img_h):
        arr = np.asarray(box, dtype=np.float64).reshape(-1)
        if arr.size < 4:
            return None
        x1, y1, x2, y2 = [float(v) for v in arr[:4]]
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        x1 = float(np.clip(x1, 0.0, float(img_w)))
        y1 = float(np.clip(y1, 0.0, float(img_h)))
        x2 = float(np.clip(x2, 0.0, float(img_w)))
        y2 = float(np.clip(y2, 0.0, float(img_h)))
        if x2 <= x1 or y2 <= y1:
            return None
        return [x1, y1, x2, y2]

    def _sanitize_entries(self, raw_boxes, raw_labels, raw_scores, img_w, img_h):
        filtered = []
        for i, score in enumerate(raw_scores):
            if i >= len(raw_boxes) or i >= len(raw_labels):
                continue
            try:
                s = float(score)
                l = int(raw_labels[i])
            except (TypeError, ValueError):
                continue
            if s < self.conf_thresh:
                continue
            try:
                box = self._sanitize_box(raw_boxes[i], img_w, img_h)
            except (TypeError, ValueError):
                continue
            if box is None:
                continue
            filtered.append((box, l, s))
        return filtered

    def _build_axis_bounds(self, boxes, axis, frame_start, frame_end):
        if not boxes:
            return [float(frame_start), float(frame_end)]
        ai, ae = (1, 3) if axis == "y" else (0, 2)
        sorted_boxes = sorted(boxes, key=lambda b: (b[ai] + b[ae]) / 2.0)
        bounds = [float(frame_start)]
        for i in range(len(sorted_boxes) - 1):
            mid = (sorted_boxes[i][ae] + sorted_boxes[i + 1][ai]) / 2.0
            bounds.append(float(np.clip(mid, bounds[-1], float(frame_end))))
        bounds.append(float(frame_end))
        return bounds

    def _axis_overlap_ratio(self, box, interval_start, interval_end, axis):
        bs, be = (box[1], box[3]) if axis == "y" else (box[0], box[2])
        inter = max(0.0, min(be, interval_end) - max(bs, interval_start))
        return inter / max(1.0, interval_end - interval_start)

    def _dedupe_span_candidates(self, spans):
        deduped = []
        for label in sorted({s[2] for s in spans}):
            group = [s for s in spans if s[2] == label]
            keep = self._nms([s[0] for s in group], [s[1] for s in group])
            deduped.extend(group[i] for i in keep)
        return deduped

    def extract_cells(self, raw_boxes, raw_labels, raw_scores, img_w, img_h, frame_box=None, label_map=None):
        self.last_notes = ()
        filtered = self._sanitize_entries(list(raw_boxes), list(raw_labels), list(raw_scores), img_w, img_h)
        if not filtered:
            return [], [], []
        active_frame = _coerce_frame_box(frame_box, img_w, img_h)
        rows, cols, spans = [], [], []
        for box, label, score in filtered:
            label_name = _resolve_structure_label_name(label, label_map)
            if label_name in STRUCTURE_ROW_LABELS:
                rows.append((box, score))
            elif label_name in STRUCTURE_COLUMN_LABELS:
                cols.append((box, score))
            elif label_name in STRUCTURE_SPAN_LABELS:
                spans.append((box, score, label))
        if not rows or not cols:
            return [], [], []
        rk = self._nms([r[0] for r in rows], [r[1] for r in rows])
        rows = [rows[i] for i in rk]
        ck = self._nms([c[0] for c in cols], [c[1] for c in cols])
        cols = [cols[i] for i in ck]
        spans = self._dedupe_span_candidates(spans)
        if not rows or not cols:
            return [], [], []
        rows.sort(key=lambda r: (r[0][1] + r[0][3]) / 2.0)
        # Remove glitch row detections that overlap with real rows
        rows = self._dedup_rows_by_overlap(rows)
        cols.sort(key=lambda c: (c[0][0] + c[0][2]) / 2.0)
        rb = self._build_axis_bounds([r[0] for r in rows], "y", active_frame[1], active_frame[3])
        cb = self._build_axis_bounds([c[0] for c in cols], "x", active_frame[0], active_frame[2])
        nr, nc = max(0, len(rb) - 1), max(0, len(cb) - 1)
        if nr == 0 or nc == 0:
            return [], [], []
        base = [{"row_start": ri, "row_end": ri, "col_start": ci, "col_end": ci,
                 "bbox": [cb[ci], rb[ri], cb[ci+1], rb[ri+1]], "is_spanning": False, "label": 0, "score": 1.0}
                for ri in range(nr) for ci in range(nc)]
        cands = []
        ign, drp = 0, 0
        for sb, ss, sl in spans:
            hr = [ri for ri in range(nr) if self._axis_overlap_ratio(sb, rb[ri], rb[ri+1], "y") > self.span_overlap_thresh]
            hc = [ci for ci in range(nc) if self._axis_overlap_ratio(sb, cb[ci], cb[ci+1], "x") > self.span_overlap_thresh]
            if not hr or not hc:
                drp += 1; continue
            rs, re = min(hr), max(hr)
            cs, ce = min(hc), max(hc)
            if rs == re and cs == ce:
                ign += 1; continue
            rf = float(np.mean([self._axis_overlap_ratio(sb, rb[ri], rb[ri+1], "y") for ri in range(rs, re+1)]))
            cf = float(np.mean([self._axis_overlap_ratio(sb, cb[ci], cb[ci+1], "x") for ci in range(cs, ce+1)]))
            cands.append({"row_start": rs, "row_end": re, "col_start": cs, "col_end": ce,
                         "bbox": [cb[cs], rb[rs], cb[ce+1], rb[re+1]], "is_spanning": True,
                         "label": int(sl), "score": float(ss), "fit_quality": min(rf, cf),
                         "cell_count": (re-rs+1)*(ce-cs+1)})
        cands.sort(key=lambda c: (c["fit_quality"], c["cell_count"], c["score"]), reverse=True)
        seen, deduped = set(), []
        for c in cands:
            k = (c["label"], c["row_start"], c["row_end"], c["col_start"], c["col_end"])
            if k not in seen:
                seen.add(k); deduped.append(c)
        covered, conf, final = set(), 0, []
        for c in deduped:
            ids = [(ri, ci) for ri in range(c["row_start"], c["row_end"]+1) for ci in range(c["col_start"], c["col_end"]+1)]
            if any(i in covered for i in ids):
                conf += 1; continue
            final.append(c); covered.update(ids)
        for c in base:
            if (c["row_start"], c["col_start"]) not in covered:
                final.append(c)
        final.sort(key=lambda c: (c["row_start"], c["col_start"], c["row_end"], c["col_end"]))
        notes = []
        if ign: notes.append(f"ignored {ign} single-interval span(s)")
        if drp: notes.append(f"dropped {drp} unaligned span(s)")
        if conf: notes.append(f"discarded {conf} conflicting span(s)")
        self.last_notes = tuple(notes)
        return final, rb, cb


def _postprocess_tsr_output(tsr_raw, crop_origin, crop_size, image_size, table_id):
    image_w, image_h = image_size
    crop_w, crop_h = crop_size
    crop_x0, crop_y0 = float(crop_origin[0]), float(crop_origin[1])

    raw_boxes = tsr_raw["boxes"]
    raw_labels = tsr_raw["labels"]
    raw_scores = tsr_raw["scores"]
    label_map = tsr_raw.get("label_map") or {}

    fb, fl, fs = [], [], []
    for box, label, score in zip(raw_boxes, raw_labels, raw_scores):
        if int(label) == 0 or score < TSR_CONF_THRESHOLD:
            continue
        x1, y1, x2, y2 = [float(v) for v in box]
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        x1 = float(np.clip(x1, 0.0, float(crop_w)))
        y1 = float(np.clip(y1, 0.0, float(crop_h)))
        x2 = float(np.clip(x2, 0.0, float(crop_w)))
        y2 = float(np.clip(y2, 0.0, float(crop_h)))
        if x2 <= x1 or y2 <= y1:
            continue
        fb.append([x1, y1, x2, y2])
        fl.append(int(label))
        fs.append(float(score))

    if fb:
        keep = _batched_nms_indices(fb, fs, fl, TSR_NMS_IOU)
        fb = [[round(v, 1) for v in fb[i]] for i in keep]
        fl = [fl[i] for i in keep]
        fs = [round(fs[i], 4) for i in keep]

    # Build structures in absolute coords
    structures = []
    for box, label, score in zip(fb, fl, fs):
        abs_box = _clip_box(
            (crop_x0 + box[0], crop_y0 + box[1], crop_x0 + box[2], crop_y0 + box[3]),
            image_w, image_h,
        )
        structures.append(
            Detection(
                label=_resolve_structure_label_name(label, label_map),
                bbox=tuple(round(v, 1) for v in abs_box),
                score=float(score),
                source="prediction",
                table_id=table_id,
                extra={"class_id": int(label)},
            )
        )

    # Extract cells using PreciseTableCellExtractor
    extractor = PreciseTableCellExtractor(
        conf_thresh=0.0,
        nms_iou_thresh=TSR_NMS_IOU,
        span_overlap_thresh=TSR_SPAN_OVERLAP_THRESH,
    )
    cells_raw, row_bounds, col_bounds = extractor.extract_cells(
        fb, fl, fs, crop_w, crop_h, frame_box=None, label_map=label_map
    )

    cells = []
    for c in cells_raw:
        bx1, by1, bx2, by2 = [float(v) for v in c["bbox"]]
        abs_box = _clip_box((crop_x0 + bx1, crop_y0 + by1, crop_x0 + bx2, crop_y0 + by2), image_w, image_h)
        cells.append(
            CellPrediction(
                bbox=tuple(round(v, 1) for v in abs_box),
                row=int(c["row_start"]),
                col=int(c["col_start"]),
                table_id=table_id,
                row_span=int(c["row_end"]) - int(c["row_start"]) + 1,
                col_span=int(c["col_end"]) - int(c["col_start"]) + 1,
                extra={},
            )
        )

    grid = TableGrid(
        cells=cells,
        row_bounds=tuple(round(float(crop_y0 + v), 1) for v in row_bounds),
        col_bounds=tuple(round(float(crop_x0 + v), 1) for v in col_bounds),
        notes=tuple(extractor.last_notes),
    )
    return structures, grid


def run_tsr_inference(table_crop, processor, model):
    device = getattr(model, "_runtime_device", _torch_runtime_device())
    inputs = processor(images=[table_crop], return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = model(**inputs)

    target_sizes = torch.tensor([[table_crop.size[1], table_crop.size[0]]], device=device)
    tsr_raw = processor.post_process_object_detection(
        outputs, target_sizes=target_sizes, threshold=0.0
    )[0]
    label_map = {int(k): str(v) for k, v in getattr(model.config, "id2label", {}).items()}
    return {
        "boxes": tsr_raw["boxes"].detach().cpu().numpy().tolist(),
        "labels": tsr_raw["labels"].detach().cpu().numpy().tolist(),
        "scores": tsr_raw["scores"].detach().cpu().numpy().tolist(),
        "label_map": label_map,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Phase 2+3 — Text Detection + Recognition (RapidOCR) — per table crop
# ═══════════════════════════════════════════════════════════════════════════

def _pil_to_bgr(image):
    if image.mode != "RGB":
        image = image.convert("RGB")
    rgb = np.asarray(image)
    return np.ascontiguousarray(rgb[:, :, ::-1])


def _flatten_numbers(value):
    if isinstance(value, _Real):
        return [float(value)]
    if isinstance(value, _Seq) and not isinstance(value, (str, bytes, bytearray)):
        out = []
        for item in value:
            out.extend(_flatten_numbers(item))
        return out
    return []


def _coerce_bbox(raw_box):
    nums = _flatten_numbers(raw_box)
    if len(nums) < 4:
        return None
    if len(nums) >= 8 and len(nums) % 2 == 0:
        xs, ys = nums[0::2], nums[1::2]
        x1, x2 = min(xs), max(xs)
        y1, y2 = min(ys), max(ys)
    else:
        x1, y1, x2, y2 = nums[:4]
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return (float(x1), float(y1), float(x2), float(y2))


def _coerce_score(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_ocr_seq(value):
    if value is None:
        return ()
    if isinstance(value, np.ndarray):
        return () if value.ndim == 0 else tuple(value.tolist())
    if isinstance(value, _Seq) and not isinstance(value, (str, bytes, bytearray)):
        return tuple(value)
    try:
        return tuple(value)
    except TypeError:
        return ()


def _extract_ocr_items_from_fields(raw_boxes, raw_texts, raw_scores, score_threshold):
    texts = _coerce_ocr_seq(raw_texts)
    if not texts:
        return []
    boxes = _coerce_ocr_seq(raw_boxes)
    scores = _coerce_ocr_seq(raw_scores)
    items = []
    for i, raw_text in enumerate(texts):
        text = " ".join(str(raw_text).split())
        if not text:
            continue
        score = _coerce_score(scores[i] if i < len(scores) else None)
        if score is not None and score < score_threshold:
            continue
        bbox = _coerce_bbox(boxes[i] if i < len(boxes) else None)
        if bbox is None:
            continue
        items.append((bbox, text, score))
    return items


def _extract_ocr_items(result, score_threshold=CELL_OCR_SCORE_THRESHOLD):
    if isinstance(result, tuple) and result:
        first = result[0]
        if hasattr(first, "boxes") or isinstance(first, (dict, list, tuple)):
            result = first
    if result is None:
        return []
    rb = getattr(result, "boxes", None)
    rt = getattr(result, "txts", None)
    rs = getattr(result, "scores", None)
    if rb is not None and rt is not None:
        return _extract_ocr_items_from_fields(rb, rt, rs, score_threshold)
    if isinstance(result, dict):
        if "boxes" in result and "txts" in result:
            return _extract_ocr_items_from_fields(result.get("boxes"), result.get("txts"), result.get("scores"), score_threshold)
        return _extract_ocr_items_from_fields(
            result.get("rec_boxes", result.get("rec_polys")),
            result.get("rec_texts"),
            result.get("rec_scores"),
            score_threshold,
        )
    if not isinstance(result, _Seq) or isinstance(result, (str, bytes, bytearray)):
        return []
    items = []
    for raw_item in result:
        rb2, rt2, rs2 = None, None, None
        if isinstance(raw_item, dict):
            rb2 = raw_item.get("box", raw_item.get("bbox", raw_item.get("coordinate")))
            rt2 = raw_item.get("text", raw_item.get("txt", raw_item.get("rec_text")))
            rs2 = raw_item.get("score", raw_item.get("confidence", raw_item.get("rec_score")))
        elif isinstance(raw_item, _Seq) and not isinstance(raw_item, (str, bytes, bytearray)) and len(raw_item) >= 2:
            rb2, rt2 = raw_item[0], raw_item[1]
            rs2 = raw_item[2] if len(raw_item) > 2 else None
        if rt2 is None:
            continue
        text = " ".join(str(rt2).split())
        if not text:
            continue
        score = _coerce_score(rs2)
        if score is not None and score < score_threshold:
            continue
        bbox = _coerce_bbox(rb2)
        if bbox is None:
            continue
        items.append((bbox, text, score))
    return items


def _merge_ocr_items(items):
    """Merge OCR items into lines by Y-center proximity, then join."""
    if not items:
        return "", None
    ordered = sorted(items, key=lambda it: ((it[0][1] + it[0][3]) / 2.0, it[0][0]))
    groups, centers, heights = [], [], []
    for item in ordered:
        bbox = item[0]
        cy = (bbox[1] + bbox[3]) / 2.0
        h = max(1.0, bbox[3] - bbox[1])
        for idx, cc in enumerate(centers):
            tol = max(heights[idx], h) * 0.65
            if abs(cy - cc) <= tol:
                groups[idx].append(item)
                n = len(groups[idx])
                centers[idx] = (cc * (n - 1) + cy) / n
                heights[idx] = max(heights[idx], h)
                break
        else:
            groups.append([item])
            centers.append(cy)
            heights.append(h)
    lines, kept_scores = [], []
    for g in groups:
        g.sort(key=lambda it: it[0][0])
        lines.append(" ".join(it[1] for it in g))
        kept_scores.extend(float(it[2]) for it in g if it[2] is not None)
    text = "\n".join(l for l in lines if l)
    mean_score = round(float(np.mean(kept_scores)), 4) if kept_scores else None
    return text, mean_score


def _ocr_box_area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _intersection_area(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def _merge_cell_extra(cell: CellPrediction, **updates) -> dict:
    extra = dict(cell.extra or {})
    extra.update({k: v for k, v in updates.items() if v is not None})
    return extra


def _compute_cell_assignments(cells, ocr_items):
    """Assign OCR items to cells using overlap, center-in-cell, and nearest fallback."""
    assignments = [[] for _ in cells]
    assigned_items = 0
    if cells and ocr_items:
        cell_boxes = np.asarray([cell.bbox for cell in cells], dtype=np.float64)
        cell_x1 = cell_boxes[:, 0]
        cell_y1 = cell_boxes[:, 1]
        cell_x2 = cell_boxes[:, 2]
        cell_y2 = cell_boxes[:, 3]
        cell_w = np.maximum(1.0, cell_x2 - cell_x1)
        cell_h = np.maximum(1.0, cell_y2 - cell_y1)
        cell_area = cell_w * cell_h
        cell_cx = (cell_x1 + cell_x2) / 2.0
        cell_cy = (cell_y1 + cell_y2) / 2.0
        for item in ocr_items:
            bbox = item[0]
            ba = max(1.0, _ocr_box_area(bbox))
            ix1 = np.maximum(cell_x1, bbox[0])
            iy1 = np.maximum(cell_y1, bbox[1])
            ix2 = np.minimum(cell_x2, bbox[2])
            iy2 = np.minimum(cell_y2, bbox[3])
            inter = np.maximum(0.0, ix2 - ix1) * np.maximum(0.0, iy2 - iy1)
            ioa = inter / ba
            union = np.maximum(1.0, ba + cell_area - inter)
            iou = inter / union

            cx = (bbox[0] + bbox[2]) / 2.0
            cy = (bbox[1] + bbox[3]) / 2.0
            center_inside = (
                (cx >= cell_x1)
                & (cx <= cell_x2)
                & (cy >= cell_y1)
                & (cy <= cell_y2)
            )

            # Weighted score favors overlap while allowing center-in-cell ties.
            score = ioa + (0.20 * iou) + (0.35 * center_inside.astype(np.float64))
            best_idx = int(np.argmax(score))

            accept = float(ioa[best_idx]) >= OCR_ASSIGN_MIN_IOA or float(iou[best_idx]) >= OCR_ASSIGN_MIN_IOU
            if OCR_ASSIGN_USE_CENTER and not accept:
                accept = bool(center_inside[best_idx]) and float(inter[best_idx]) > 0.0

            if not accept and OCR_ASSIGN_USE_NEAREST:
                bw = max(1.0, float(bbox[2] - bbox[0]))
                bh = max(1.0, float(bbox[3] - bbox[1]))
                norm = max(1.0, bw, bh)
                dist = np.sqrt((cell_cx - cx) ** 2 + (cell_cy - cy) ** 2) / norm
                nearest_idx = int(np.argmin(dist))
                if float(dist[nearest_idx]) <= OCR_ASSIGN_NEAREST_MAX:
                    best_idx = nearest_idx
                    accept = True

            if accept:
                assignments[best_idx].append(item)
                assigned_items += 1
    return assignments, assigned_items


def _assign_ocr_items_to_cells(cells, ocr_items):
    assignments, assigned_items = _compute_cell_assignments(cells, ocr_items)
    annotated = []
    for cell, items in zip(cells, assignments):
        text, ocr_score = _merge_ocr_items(items)
        annotated.append(
            CellPrediction(
                bbox=cell.bbox,
                row=cell.row,
                col=cell.col,
                table_id=cell.table_id,
                row_span=cell.row_span,
                col_span=cell.col_span,
                text=text,
                ocr_score=ocr_score,
                extra=_merge_cell_extra(cell, ocr_box_count=len(items)),
            )
        )
    return annotated, assigned_items


class TableHeuristicRefiner:
    def __init__(self, table_crop, crop_origin, grid: TableGrid, table_id=None):
        self.table_crop = table_crop
        self.crop_origin = crop_origin
        self.cells = list(grid.cells)
        self.row_bounds = tuple(float(v) for v in grid.row_bounds)
        self.col_bounds = tuple(float(v) for v in grid.col_bounds)
        self.table_id = table_id
        self.notes = list(grid.notes)

    @property
    def row_count(self):
        return max(0, len(self.row_bounds) - 1)

    @property
    def col_count(self):
        return max(0, len(self.col_bounds) - 1)

    def _cell_bbox(self, row, col, row_span=1, col_span=1):
        return (
            float(self.col_bounds[col]),
            float(self.row_bounds[row]),
            float(self.col_bounds[col + col_span]),
            float(self.row_bounds[row + row_span]),
        )

    def _merge_left_anchored_spanners(self, assignments):
        if not TSR_ENABLE_LEFT_SPANNER or self.col_count <= 1:
            return
        assignment_map = {
            (cell.row, cell.col, cell.row_span, cell.col_span): items
            for cell, items in zip(self.cells, assignments)
        }
        merged_cells = []
        merged_rows = set()
        for row in range(self.row_count):
            row_cells = [
                cell for cell in self.cells
                if cell.row == row and cell.row_span == 1
            ]
            row_cells.sort(key=lambda cell: cell.col)
            if not row_cells:
                continue
            is_full_single_row = (
                len(row_cells) == self.col_count
                and all(cell.col == idx and cell.col_span == 1 for idx, cell in enumerate(row_cells))
            )
            if not is_full_single_row:
                continue
            occupancy = [assignment_map.get((cell.row, cell.col, cell.row_span, cell.col_span), ()) for cell in row_cells]
            filled = [idx for idx, items in enumerate(occupancy) if items]
            if filled != [0]:
                continue
            anchor_items = occupancy[0]
            _, anchor_score = _merge_ocr_items(anchor_items)
            if anchor_score is not None and anchor_score < TSR_LEFT_SPANNER_MIN_SCORE:
                continue
            sibling_fill_ratio = sum(1 for items in occupancy[1:] if not items) / max(1, len(occupancy) - 1)
            if sibling_fill_ratio < TSR_LEFT_SPANNER_MIN_FILL_RATIO:
                continue
            anchor = row_cells[0]
            merged_bbox = self._cell_bbox(row, 0, row_span=1, col_span=self.col_count)
            merged_cells.append(
                replace(
                    anchor,
                    bbox=tuple(round(float(v), 1) for v in merged_bbox),
                    col=0,
                    col_span=self.col_count,
                    extra=_merge_cell_extra(
                        anchor,
                        is_left_spanner=True,
                        merged_by="left_anchored_spanner",
                    ),
                )
            )
            merged_rows.add(row)
        if not merged_rows:
            return
        passthrough = [cell for cell in self.cells if cell.row not in merged_rows]
        self.cells = passthrough + merged_cells
        self.notes.append(f"merged {len(merged_rows)} left-anchored spanner row(s)")

    def refine(self, ocr_items):
        if not self.cells:
            return TableGrid(cells=[], row_bounds=self.row_bounds, col_bounds=self.col_bounds, notes=tuple(self.notes))
        assignments, _ = _compute_cell_assignments(self.cells, ocr_items)
        self._merge_left_anchored_spanners(assignments)
        self.cells.sort(key=_cell_sort_key)
        return TableGrid(
            cells=self.cells,
            row_bounds=self.row_bounds,
            col_bounds=self.col_bounds,
            notes=tuple(self.notes),
        )


def _mask_ocr_non_cell_regions(bgr, crop_origin, cells, margin=0):
    """Keep only cell regions visible for OCR to reduce noisy off-cell detections."""
    if not cells:
        return bgr
    h, w = bgr.shape[:2]
    if h <= 1 or w <= 1:
        return bgr
    crop_x0, crop_y0 = float(crop_origin[0]), float(crop_origin[1])
    mask = np.zeros((h, w), dtype=np.uint8)
    for cell in cells:
        x1 = int(np.floor(float(cell.bbox[0]) - crop_x0)) - int(margin)
        y1 = int(np.floor(float(cell.bbox[1]) - crop_y0)) - int(margin)
        x2 = int(np.ceil(float(cell.bbox[2]) - crop_x0)) + int(margin)
        y2 = int(np.ceil(float(cell.bbox[3]) - crop_y0)) + int(margin)
        x1 = max(0, min(w, x1))
        y1 = max(0, min(h, y1))
        x2 = max(0, min(w, x2))
        y2 = max(0, min(h, y2))
        if x2 <= x1 or y2 <= y1:
            continue
        mask[y1:y2, x1:x2] = 255
    if not np.any(mask):
        return bgr
    out = bgr.copy()
    out[mask == 0] = 255
    return out


def _tighten_ocr_crop(table_crop, crop_origin, cells, margin=OCR_CELL_CROP_MARGIN):
    if not cells:
        return table_crop, crop_origin
    crop_w, crop_h = table_crop.size
    crop_x0, crop_y0 = float(crop_origin[0]), float(crop_origin[1])
    rel_boxes = []
    for cell in cells:
        x1 = max(0.0, float(cell.bbox[0]) - crop_x0)
        y1 = max(0.0, float(cell.bbox[1]) - crop_y0)
        x2 = min(float(crop_w), float(cell.bbox[2]) - crop_x0)
        y2 = min(float(crop_h), float(cell.bbox[3]) - crop_y0)
        if x2 > x1 and y2 > y1:
            rel_boxes.append((x1, y1, x2, y2))
    if not rel_boxes:
        return table_crop, crop_origin
    x1 = max(0, int(min(box[0] for box in rel_boxes)) - margin)
    y1 = max(0, int(min(box[1] for box in rel_boxes)) - margin)
    x2 = min(crop_w, int(max(box[2] for box in rel_boxes)) + margin)
    y2 = min(crop_h, int(max(box[3] for box in rel_boxes)) + margin)
    if x2 - x1 < 2 or y2 - y1 < 2:
        return table_crop, crop_origin
    if x1 == 0 and y1 == 0 and x2 == crop_w and y2 == crop_h:
        return table_crop, crop_origin
    return table_crop.crop((x1, y1, x2, y2)), (crop_x0 + x1, crop_y0 + y1)


def run_table_cell_ocr(table_crop, crop_origin, grid: TableGrid, ocr_engine, table_id=None):
    """Run OCR on a table crop and assign text to cells."""
    cells = list(grid.cells)
    if not cells:
        return list(cells), tuple(grid.notes)
    ocr_crop, ocr_origin = _tighten_ocr_crop(table_crop, crop_origin, cells)
    start = perf_counter()
    bgr = _pil_to_bgr(ocr_crop)
    if _env_flag("OCR_MASK_NON_CELL_AREA", False):
        mask_margin = max(0, int(os.environ.get("OCR_MASK_MARGIN", "2")))
        bgr = _mask_ocr_non_cell_regions(bgr, ocr_origin, cells, margin=mask_margin)
    raw_output = ocr_engine(bgr, use_cls=False)
    crop_x0, crop_y0 = float(ocr_origin[0]), float(ocr_origin[1])
    abs_items = [
        ((crop_x0 + b[0], crop_y0 + b[1], crop_x0 + b[2], crop_y0 + b[3]), t, s)
        for b, t, s in _extract_ocr_items(raw_output)
    ]
    refined_grid = TableHeuristicRefiner(
        table_crop=table_crop,
        crop_origin=crop_origin,
        grid=grid,
        table_id=table_id,
    ).refine(abs_items)
    assigned_cells, assigned_item_count = _assign_ocr_items_to_cells(refined_grid.cells, abs_items)
    elapsed = perf_counter() - start
    filled_cells = sum(1 for c in assigned_cells if c.text)
    logger.info(
        "Table %s OCR: %.3fs on %dx%d crop (%dx%d after tighten), %d cells, %d filled, %d/%d boxes assigned",
        "?" if table_id is None else table_id,
        elapsed,
        table_crop.size[0],
        table_crop.size[1],
        ocr_crop.size[0],
        ocr_crop.size[1],
        len(cells),
        filled_cells,
        assigned_item_count,
        len(abs_items),
    )
    return assigned_cells, refined_grid.notes


# ═══════════════════════════════════════════════════════════════════════════
# Serialization (annotation dict for GUI/export)
# ═══════════════════════════════════════════════════════════════════════════

def _serialize_cell(cell: CellPrediction) -> dict:
    payload = {
        "bbox": [round(float(v), 1) for v in cell.bbox],
        "row": int(cell.row),
        "col": int(cell.col),
        "row_span": max(1, int(cell.row_span)),
        "col_span": max(1, int(cell.col_span)),
        "text": " ".join(str(cell.text).split()),
    }
    if PIPELINE_DEBUG_HEURISTICS and cell.extra:
        payload["extra"] = cell.extra
    return payload


def _cell_sort_key(cell):
    return (cell.row, cell.col, cell.bbox[1], cell.bbox[0])


# ═══════════════════════════════════════════════════════════════════════════
# Pipeline orchestrator
# ═══════════════════════════════════════════════════════════════════════════

def run_pipeline(image_path: str | Path) -> dict:
    """Full table extraction pipeline.

    Returns the annotation dict and writes it to
    ``<image_stem>_annotation.json`` alongside the input image.
    """
    image_path = Path(image_path)

    pil_image = Image.open(image_path).convert("RGB")
    img_w, img_h = pil_image.size

    device_mode = _pipeline_device_mode()
    providers = _selected_providers()
    logger.info("Pipeline device mode: %s", device_mode)
    logger.info("Using execution providers: %s", providers)
    providers_key = tuple(providers)
    cpu_only_runtime = providers == ["CPUExecutionProvider"]
    cache_gpu_runtimes = _cache_gpu_runtimes()
    use_cached_runtimes = cpu_only_runtime or cache_gpu_runtimes
    ocr_use_cuda = _ocr_cuda_enabled() and not cpu_only_runtime
    logger.info("Runtime caching: %s", "enabled" if use_cached_runtimes else "disabled")

    # ==================== TATR (PyTorch) MODEL PHASES ====================

    # --- Phase 1: Table Detection ---
    logger.info("Phase 1: Table Detection")
    if use_cached_runtimes:
        td_processor, td_session = _get_td_runtime(providers_key)
    else:
        td_processor, td_session = load_td_model(TD_MODEL_DIR, providers)
    table_detections = run_td_inference(pil_image, td_processor, td_session)
    logger.info("Detected %d table(s)", len(table_detections))

    # --- Phase 4: Table Structure Recognition ---
    logger.info("Phase 4: Table Structure Recognition")
    if use_cached_runtimes:
        tsr_processor, tsr_session = _get_tsr_runtime(providers_key)
    else:
        tsr_processor, tsr_session = load_tsr_model(TSR_MODEL_DIR, providers)

    table_items = []
    for table_id, td in enumerate(table_detections):
        table_crop, crop_origin = crop_table_with_padding(pil_image, td.bbox, padding_pct=PADDING_PCT)
        tsr_raw = run_tsr_inference(table_crop, tsr_processor, tsr_session)
        structures, grid = _postprocess_tsr_output(
            tsr_raw, crop_origin, table_crop.size, (img_w, img_h), table_id
        )
        table_items.append({
            "table_id": table_id,
            "detection": td,
            "crop": table_crop,
            "crop_origin": crop_origin,
            "structures": structures,
            "grid": grid,
            "cells": list(grid.cells),
            "heuristic_notes": list(grid.notes),
        })
        logger.info("Table %d: %d cell(s)", table_id, len(grid.cells))

    if not use_cached_runtimes:
        # Release transient TATR model state when runtime caching is disabled.
        del td_session, td_processor, tsr_session, tsr_processor
        if torch.cuda.is_available() and not _is_cpu_only_runtime():
            torch.cuda.empty_cache()
        gc.collect()

    # ==================== OCR PHASE ====================

    # --- Phase 2+3: Text Detection + Recognition (RapidOCR) ---
    logger.info("Phase 2+3: OCR (per table crop)")
    ocr_engine = _get_ocr_engine(ocr_use_cuda) if use_cached_runtimes else _create_ocr_engine(use_cuda=ocr_use_cuda)
    ocr_phase_start = perf_counter()

    for table_item in table_items:
        if not table_item["cells"]:
            continue
        table_item["cells"], notes = run_table_cell_ocr(
            table_crop=table_item["crop"],
            crop_origin=table_item["crop_origin"],
            grid=table_item["grid"],
            ocr_engine=ocr_engine,
            table_id=table_item["table_id"],
        )
        table_item["heuristic_notes"] = list(notes)
    if not use_cached_runtimes:
        del ocr_engine
    logger.info("OCR complete in %.3fs", perf_counter() - ocr_phase_start)

    # ==================== BUILD ANNOTATION ====================

    tables = []
    for ti in table_items:
        ordered_cells = sorted(ti["cells"], key=_cell_sort_key)
        tables.append({
            "table_id": ti["table_id"],
            "bbox": [round(float(v), 1) for v in ti["detection"].bbox],
            "cells": [_serialize_cell(c) for c in ordered_cells],
            **({"heuristic_notes": list(ti["heuristic_notes"])} if PIPELINE_DEBUG_HEURISTICS and ti["heuristic_notes"] else {}),
        })

    annotation: dict[str, Any] = {
        "source_image": image_path.name,
        "image_size":   [img_w, img_h],
        "tables":       tables,
    }

    out_path = image_path.parent / f"{image_path.stem}_annotation.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(annotation, f, indent=2, ensure_ascii=False)
    logger.info("Annotation written to %s", out_path)

    return annotation


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
    )
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <image_path>")
        sys.exit(1)
    run_pipeline(sys.argv[1])
