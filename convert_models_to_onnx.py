import json
import logging
import os
from pathlib import Path

import torch
from transformers import AutoImageProcessor, TableTransformerConfig, TableTransformerForObjectDetection

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TD_MODEL_DIR  = Path(os.environ.get("TD_MODEL_DIR",  r"A:\Ag27\TATR_TD"))
TSR_MODEL_DIR = Path(os.environ.get("TSR_MODEL_DIR", r"A:\Ag27\TableStructureDetection"))

def load_td_model(model_dir):
    model_dir = Path(model_dir)
    processor = AutoImageProcessor.from_pretrained(model_dir, use_fast=False)
    with open(model_dir / "config.json", "r") as f:
        cfg = json.load(f)
    cfg.pop("backbone_config", None)
    cfg["backbone"] = "resnet18"
    cfg["use_timm_backbone"] = True
    config = TableTransformerConfig.from_dict(cfg)
    model = TableTransformerForObjectDetection.from_pretrained(
        model_dir, config=config, ignore_mismatched_sizes=True
    )
    model.eval()
    return processor, model

def load_tsr_model(model_dir):
    model_dir = Path(model_dir)
    processor = AutoImageProcessor.from_pretrained(model_dir, use_fast=False)
    config = TableTransformerConfig.from_pretrained(model_dir)
    config.backbone = None
    model = TableTransformerForObjectDetection.from_pretrained(
        model_dir, config=config, ignore_mismatched_sizes=True
    )
    model.eval()
    return processor, model

def export_model_to_onnx(model, onnx_path):
    # Create dummy inputs
    # TableTransformer generally processes 3-channel RGB images.
    # We use a standard size for dummy input, dynamic axes will allow variable size
    dummy_pixel_values = torch.randn(1, 3, 800, 800)
    dummy_pixel_mask = torch.ones(1, 800, 800, dtype=torch.int64)

    input_names = ["pixel_values", "pixel_mask"]
    output_names = ["logits", "pred_boxes"]

    dynamic_axes = {
        "pixel_values": {0: "batch_size", 2: "height", 3: "width"},
        "pixel_mask": {0: "batch_size", 1: "height", 2: "width"},
        "logits": {0: "batch_size", 1: "num_queries"},
        "pred_boxes": {0: "batch_size", 1: "num_queries"}
    }

    logger.info(f"Exporting model to {onnx_path}...")
    torch.onnx.export(
        model,
        (dummy_pixel_values, dummy_pixel_mask),
        onnx_path,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=14, # 14 is generally stable for transformers
        do_constant_folding=True
    )
    logger.info(f"Successfully exported {onnx_path}")

def main():
    logger.info("Loading TD Model...")
    td_processor, td_model = load_td_model(TD_MODEL_DIR)
    td_onnx_path = TD_MODEL_DIR / "model.onnx"
    export_model_to_onnx(td_model, td_onnx_path)

    logger.info("Loading TSR Model...")
    tsr_processor, tsr_model = load_tsr_model(TSR_MODEL_DIR)
    tsr_onnx_path = TSR_MODEL_DIR / "model.onnx"
    export_model_to_onnx(tsr_model, tsr_onnx_path)

if __name__ == "__main__":
    main()
