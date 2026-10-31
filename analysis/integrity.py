"""mri-integrity-v1: identifiers in, bounded measurements and artifact IDs out."""

import argparse
import hashlib
import io
import json
import platform
import sys
import zlib
from datetime import UTC, datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import itertools

import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np
import PIL
from PIL import Image

PIPELINE_VERSION = "mri-integrity-v1"
MAX_MONTAGE_BYTES = 150 * 1024
PARAMETERS = {
    "percentiles": [2, 98],
    "foreground_threshold": 0.10,
    "supported_slice_fraction": 0.01,
    "minimum_blank_run": 2,
}


class ToolError(Exception):
    """Safe operational error code; never forward local exceptions or paths."""


def analyze_scan(dataset_root, manifest, acquisition_id, evidence_dir):
    """Analyze one immutable acquisition from a trusted site-local manifest.

    Input/manifest failures raise ToolError and must fail the job. Image integrity
    failures return findings. Preview failures remain separately retryable.
    """
    matches = [
        item
        for item in manifest["acquisitions"]
        if item["acquisition_id"] == acquisition_id
    ]
    if len(matches) != 1:
        raise ToolError("UNKNOWN_OR_DUPLICATE_ACQUISITION")
    entry = matches[0]
    root = Path(dataset_root).resolve()
    relative = Path(entry["path"])
    path = (root / relative).resolve()
    if relative.is_absolute() or not path.is_relative_to(root):
        raise ToolError("INPUT_OUTSIDE_DATASET")
    try:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError:
        raise ToolError("INPUT_UNAVAILABLE") from None
    if digest != entry["sha256"]:
        raise ToolError("INPUT_HASH_MISMATCH")

    result = {
        "schema_version": 1,
        "site_id": manifest["site_id"],
        "subject_id": entry["subject_id"],
        "acquisition_id": acquisition_id,
        "input_sha256": digest,
        "checks_passed": False,
        "findings": [],
        "measurements": {},
        "evidence": {"status": "unrenderable", "error": None},
        "provenance": {
            "pipeline_version": PIPELINE_VERSION,
            "parameters": PARAMETERS.copy(),
            "packages": {
                "python": platform.python_version(),
                "nibabel": nib.__version__,
                "numpy": np.__version__,
                "matplotlib": matplotlib.__version__,
                "pillow": PIL.__version__,
            },
            "timestamp": datetime.now(UTC).isoformat(),
            "tool_exit_status": 0,
            "source": entry["source"],
            "synthetic_transformation": entry.get("synthetic_transformation"),
        },
    }

    try:
        image = nib.load(path)
    except (
        OSError,
        ValueError,
        EOFError,
        zlib.error,
        nib.filebasedimages.ImageFileError,
    ):
        result["findings"].append({"code": "UNREADABLE_IMAGE"})
        result["evidence"]["error"] = "UNREADABLE_IMAGE"
        return result
    if (
        len(image.shape) != 3
        or any(size == 0 for size in image.shape)
        or image.get_data_dtype().kind not in "iuf"
    ):
        result["findings"].append({"code": "UNSUPPORTED_VOLUME"})
        result["evidence"]["error"] = "UNSUPPORTED_VOLUME"
        return result
    affine = image.affine
    zooms = np.asarray(image.header.get_zooms())
    if (
        affine is None
        or not np.isfinite(affine).all()
        or np.linalg.det(affine[:3, :3]) == 0
        or not np.isfinite(zooms).all()
        or np.any(zooms <= 0)
    ):
        result["findings"].append({"code": "INVALID_GEOMETRY"})
        result["evidence"]["error"] = "INVALID_GEOMETRY"
        return result
    try:
        image = nib.as_closest_canonical(image)
        data = image.get_fdata(dtype=np.float64)
    except (OSError, ValueError, EOFError, zlib.error):
        result["findings"].append({"code": "UNREADABLE_IMAGE"})
        result["evidence"]["error"] = "UNREADABLE_IMAGE"
        return result

    spacing = nib.affines.voxel_sizes(image.affine)
    finite = np.isfinite(data)
    nonfinite_count = int(data.size - np.count_nonzero(finite))
    measurements = result["measurements"]
    measurements.update(
        {
            "orientation": list(nib.aff2axcodes(image.affine)),
            "shape": list(data.shape),
            "voxel_spacing_mm": spacing.tolist(),
            "nonfinite_count": nonfinite_count,
            "nonfinite_fraction": nonfinite_count / data.size,
            "foreground_fraction": None,
            "foreground_bbox_extent_mm": None,
            "intensity_window": None,
            "blank_slab_intervals_z": [],
        }
    )
    if nonfinite_count:
        result["findings"].append(
            {"code": "NONFINITE_VALUES", "count": nonfinite_count}
        )
    if not finite.any():
        result["evidence"]["error"] = "NO_FINITE_VALUES"
        return result

    low, high = np.percentile(data[finite], PARAMETERS["percentiles"])
    measurements["intensity_window"] = [float(low), float(high)]
    mask = np.zeros(data.shape, dtype=bool)
    if high <= low:
        result["findings"].append({"code": "DEGENERATE_SIGNAL"})
    else:
        # Invalid voxels never contribute to foreground, and remain a failure.
        normalized = np.zeros(data.shape, dtype=np.float64)
        normalized[finite] = np.clip((data[finite] - low) / (high - low), 0, 1)
        mask = normalized > PARAMETERS["foreground_threshold"]
        if not mask.any():
            result["findings"].append({"code": "EMPTY_FOREGROUND"})
    measurements["foreground_fraction"] = float(np.mean(mask))
    if mask.any():
        bounds = []
        for axis in range(3):
            occupied = np.flatnonzero(
                np.any(mask, axis=tuple(i for i in range(3) if i != axis))
            )
            bounds.append(int(occupied[-1] - occupied[0] + 1))
        measurements["foreground_bbox_extent_mm"] = (
            np.array(bounds) * spacing
        ).tolist()
    occupancy = np.mean(mask, axis=(0, 1))
    supported = np.flatnonzero(occupancy >= PARAMETERS["supported_slice_fraction"])
    gaps = []
    if supported.size:
        for left, right in itertools.pairwise(supported):
            if right - left - 1 >= PARAMETERS["minimum_blank_run"]:
                gaps.append([int(left + 1), int(right - 1)])
    measurements["blank_slab_intervals_z"] = gaps
    if gaps:
        result["findings"].append({"code": "INTERNAL_BLANK_SLAB", "intervals_z": gaps})
    result["checks_passed"] = not result["findings"]

    try:
        png, slices = _montage(data, spacing, low, high, gaps)
        artifact_id = hashlib.sha256(png).hexdigest()
        output = Path(evidence_dir)
        output.mkdir(parents=True, exist_ok=True)
        (output / f"{artifact_id}.png").write_bytes(png)
        result["evidence"] = {
            "status": "ready",
            "artifact_id": artifact_id,
            "sha256": artifact_id,
            "media_type": "image/png",
            "bytes": len(png),
            "slices": slices,
            "intensity_window": [float(low), float(high)],
        }
    except (OSError, ValueError, ToolError):
        # A rendering/storage failure is NOT an unrenderable-volume exemption.
        result["evidence"] = {"status": "missing", "error": "PREVIEW_FAILED"}
    return result


def _montage(data, spacing, low, high, gaps):
    slices = [
        {"plane": "sagittal", "axis": 0, "index": data.shape[0] // 2},
        {"plane": "coronal", "axis": 1, "index": data.shape[1] // 2},
        {"plane": "axial", "axis": 2, "index": data.shape[2] // 2},
    ]
    # Each flagged interval gets its own interior and two supporting neighbors.
    for start, end in gaps:
        for index in (start - 1, (start + end) // 2, end + 1):
            slices.append({"plane": "axial (slab evidence)", "axis": 2, "index": index})
    figure, axes = plt.subplots(
        len(slices) // 3, 3, figsize=(9, 3 * (len(slices) // 3)), squeeze=False
    )
    try:
        for axis, selected in zip(axes.flat, slices):
            dimension = selected["axis"]
            plane = np.take(data, selected["index"], axis=dimension).T
            remaining = [i for i in range(3) if i != dimension]
            horizontal, vertical = remaining
            axis.imshow(
                np.ma.masked_invalid(plane),
                cmap="gray",
                origin="lower",
                vmin=low,
                vmax=high if high > low else low + 1,
                extent=(
                    0,
                    plane.shape[1] * spacing[horizontal],
                    0,
                    plane.shape[0] * spacing[vertical],
                ),
                interpolation="nearest",
            )
            axis.set_title(f"{selected['plane']} · {selected['index']}", fontsize=10)
            labels = ["L → R", "P → A", "I → S"]
            axis.set_xlabel(labels[horizontal], fontsize=9)
            axis.set_ylabel(labels[vertical], fontsize=9)
            axis.set_xticks([])
            axis.set_yticks([])
        figure.suptitle("RAS-oriented voxel slices · Not for clinical use", fontsize=11)
        figure.tight_layout()
        for dpi in (100, 80, 60):
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png", dpi=dpi)
            # The montage is entirely grayscale. Store one channel rather than
            # RGBA, preserving every displayed intensity and evidence panel.
            with Image.open(buffer) as rendered:
                compressed = io.BytesIO()
                rendered.convert("L").save(compressed, format="PNG", optimize=True)
            png = compressed.getvalue()
            if len(png) <= MAX_MONTAGE_BYTES:
                return png, slices
        raise ToolError("PREVIEW_TOO_LARGE")
    finally:
        plt.close(figure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--acquisition-id", required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        result = analyze_scan(
            args.dataset_root, manifest, args.acquisition_id, args.evidence_dir
        )
        print(json.dumps(result, allow_nan=False))
    except ToolError as error:
        print(json.dumps({"error": str(error), "tool_exit_status": 1}))
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"error": "INVALID_TOOL_INPUT", "tool_exit_status": 1}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
