import copy
import gzip
import hashlib
import json
import subprocess
import sys

import nibabel as nib
import numpy as np
import pytest
from PIL import Image

from analysis.integrity import ToolError, analyze_scan


@pytest.fixture
def volume():
    data = np.zeros((12, 16, 18), dtype=np.float32)
    data[2:10, 3:13, 4:16] = 100
    return data


@pytest.fixture
def scan(tmp_path):
    root = tmp_path / "dataset"
    root.mkdir()
    evidence = tmp_path / "evidence"

    def save(data, affine=None):
        path = root / "scan.nii"
        image = nib.Nifti1Image(data, np.diag([2, 3, 4, 1]))
        if affine is not None:
            image.set_sform(affine, code=1)
        nib.save(image, path)
        manifest = {
            "site_id": "site-a",
            "acquisitions": [
                {
                    "acquisition_id": "scan-a",
                    "subject_id": "subject-a",
                    "path": "scan.nii",
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "source": {"name": "Synthetic test array; not a research scan"},
                }
            ],
        }
        return root, manifest, "scan-a", evidence

    return save


def test_physical_measurements_and_bounded_real_png(scan, volume):
    args = scan(volume)
    result = analyze_scan(*args)
    assert result["checks_passed"]
    assert result["findings"] == []
    assert result["measurements"] == {
        "orientation": ["R", "A", "S"],
        "shape": [12, 16, 18],
        "voxel_spacing_mm": [2, 3, 4],
        "nonfinite_count": 0,
        "nonfinite_fraction": 0,
        "foreground_fraction": 960 / 3456,
        "foreground_bbox_extent_mm": [16, 30, 48],
        "intensity_window": [0, 100],
        "blank_slab_intervals_z": [],
    }
    evidence = result["evidence"]
    png = args[3] / f"{evidence['artifact_id']}.png"
    with Image.open(png) as image:
        image.verify()
        assert image.format == "PNG"
    assert hashlib.sha256(png.read_bytes()).hexdigest() == evidence["sha256"]
    assert 0 < png.stat().st_size == evidence["bytes"] <= 150 * 1024
    assert str(args[0]) not in json.dumps(result, allow_nan=False)


def test_foreground_threshold_is_strict(scan, volume):
    volume[3, 4, 5] = 10
    volume[3, 4, 6] = 11
    result = analyze_scan(*scan(volume))
    assert result["checks_passed"]
    assert result["measurements"]["intensity_window"] == [0, 100]
    assert result["measurements"]["foreground_fraction"] == 959 / 3456


@pytest.mark.parametrize(
    "gap,expected", [(0, []), (1, []), (2, [[8, 9]]), (3, [[8, 10]])]
)
def test_only_internal_two_or_more_slice_gaps_flag(scan, volume, gap, expected):
    volume[:, :, 8 : 8 + gap] = 0
    result = analyze_scan(*scan(volume))
    assert result["measurements"]["blank_slab_intervals_z"] == expected
    assert result["checks_passed"] is (not expected)
    if expected:
        assert result["findings"] == [
            {"code": "INTERNAL_BLANK_SLAB", "intervals_z": expected}
        ]
        evidence_slices = result["evidence"]["slices"][3:]
        assert [s["index"] for s in evidence_slices] == [7, (8 + 7 + gap) // 2, 8 + gap]


@pytest.mark.parametrize("pixels,flagged", [(3, True), (4, False)])
def test_one_percent_occupancy_boundary(scan, pixels, flagged):
    data = np.zeros((20, 20, 12), dtype=np.float32)
    data[4:16, 4:16, 2:10] = 100
    data[:, :, 5:7] = 0
    data[0:pixels, 0, 5:7] = 100
    result = analyze_scan(*scan(data))
    assert result["measurements"]["blank_slab_intervals_z"] == (
        [[5, 6]] if flagged else []
    )


def test_canonical_axes_not_storage_axes(scan, volume):
    volume[:, :, 8:10] = 0
    # Storage axes are z, y, -x. Canonicalizing must recover x, y, z.
    stored = np.transpose(volume[::-1, :, :], (2, 1, 0))
    affine = np.array([[0, 0, -2, 22], [0, 3, 0, 0], [4, 0, 0, 0], [0, 0, 0, 1]])
    result = analyze_scan(*scan(stored, affine))
    assert result["measurements"]["shape"] == [12, 16, 18]
    assert result["measurements"]["voxel_spacing_mm"] == [2, 3, 4]
    assert result["measurements"]["foreground_bbox_extent_mm"] == [16, 30, 48]
    assert result["measurements"]["blank_slab_intervals_z"] == [[8, 9]]
    assert result["measurements"]["foreground_fraction"] == 800 / 3456


@pytest.mark.parametrize("value", [np.nan, np.inf, -np.inf])
def test_nonfinite_voxels_never_pass_or_leak_invalid_json(scan, volume, value):
    volume[3, 4, 5] = value
    result = analyze_scan(*scan(volume))
    assert not result["checks_passed"]
    assert result["findings"] == [{"code": "NONFINITE_VALUES", "count": 1}]
    assert result["measurements"]["nonfinite_fraction"] == 1 / 3456
    assert result["measurements"]["foreground_fraction"] == 959 / 3456
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize(
    "value,error,preview",
    [
        (0, "DEGENERATE_SIGNAL", "ready"),
        (7, "DEGENERATE_SIGNAL", "ready"),
        (np.nan, "NONFINITE_VALUES", "unrenderable"),
    ],
)
def test_degenerate_arrays_are_not_healthy(scan, volume, value, error, preview):
    volume.fill(value)
    result = analyze_scan(*scan(volume))
    assert not result["checks_passed"]
    assert result["findings"][0]["code"] == error
    assert result["evidence"]["status"] == preview
    assert result["measurements"]["foreground_bbox_extent_mm"] is None
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize(
    "case,code",
    [
        ("unreadable", "UNREADABLE_IMAGE"),
        ("truncated", "UNREADABLE_IMAGE"),
        ("truncated-gzip", "UNREADABLE_IMAGE"),
        ("corrupt-gzip", "UNREADABLE_IMAGE"),
        ("4d", "UNSUPPORTED_VOLUME"),
        ("singular", "INVALID_GEOMETRY"),
        ("nonfinite-affine", "INVALID_GEOMETRY"),
    ],
)
def test_unrenderable_input_has_no_fake_evidence(scan, volume, case, code):
    affine = np.diag([2.0, 3, 4, 1])
    if case == "singular":
        affine[0, 0] = 0
    if case == "nonfinite-affine":
        affine[0, 3] = np.nan
    args = scan(volume[..., None] if case == "4d" else volume, affine)
    path = args[0] / "scan.nii"
    if case in ("unreadable", "truncated"):
        path.write_bytes(
            b"not an image" if case == "unreadable" else path.read_bytes()[:400]
        )
    if case in ("truncated-gzip", "corrupt-gzip"):
        compressed = bytearray(gzip.compress(path.read_bytes(), mtime=0))
        if case == "truncated-gzip":
            compressed = compressed[:30]
        else:
            compressed[12:20] = b"\xff" * 8
        path = path.with_suffix(".nii.gz")
        path.write_bytes(compressed)
        args[1]["acquisitions"][0]["path"] = path.name
    args[1]["acquisitions"][0]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    result = analyze_scan(*args)
    assert not result["checks_passed"]
    assert result["findings"] == [{"code": code}]
    assert result["evidence"] == {"status": "unrenderable", "error": code}
    assert not args[3].exists()


def test_input_identity_and_site_boundary(scan, volume, tmp_path):
    args = scan(volume)
    root, manifest, acquisition_id, evidence = args
    with pytest.raises(ToolError, match="UNKNOWN_OR_DUPLICATE_ACQUISITION"):
        analyze_scan(root, manifest, "nonexistent", evidence)
    bad = copy.deepcopy(manifest)
    bad["acquisitions"][0]["sha256"] = "0" * 64
    with pytest.raises(ToolError, match="INPUT_HASH_MISMATCH"):
        analyze_scan(root, bad, acquisition_id, evidence)
    outside = tmp_path / "outside.nii"
    outside.write_bytes((root / "scan.nii").read_bytes())
    (root / "escape.nii").symlink_to(outside)
    for path in ("../outside.nii", str(outside), "escape.nii"):
        bad = copy.deepcopy(manifest)
        bad["acquisitions"][0]["path"] = path
        with pytest.raises(ToolError, match="INPUT_OUTSIDE_DATASET"):
            analyze_scan(root, bad, acquisition_id, evidence)


def test_preview_failure_is_retryable_not_unrenderable(scan, volume):
    args = scan(volume)
    args[3].write_text("Not a directory")
    result = analyze_scan(*args)
    assert result["checks_passed"]
    assert result["evidence"] == {"status": "missing", "error": "PREVIEW_FAILED"}


def test_cli_reports_safe_operational_failure(scan, volume, tmp_path):
    root, manifest, acquisition_id, evidence = scan(volume)
    manifest["acquisitions"][0]["sha256"] = "0" * 64
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    command = subprocess.run(
        [
            sys.executable,
            "-m",
            "analysis.integrity",
            "--dataset-root",
            str(root),
            "--manifest",
            str(manifest_path),
            "--acquisition-id",
            acquisition_id,
            "--evidence-dir",
            str(evidence),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert command.returncode == 1
    assert json.loads(command.stdout) == {
        "error": "INPUT_HASH_MISMATCH",
        "tool_exit_status": 1,
    }
    assert command.stderr == ""
