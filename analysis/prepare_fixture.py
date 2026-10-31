"""Prepare and validate one site's licensed public MRI demo fixture locally.

Run separately inside each site VM when provisioning is authorized. This command
does not provision VMs, contact an LLM, or send image data to another service.
"""

import argparse
import hashlib
import json
import shutil
import time
import urllib.request
from pathlib import Path

import nibabel as nib
import numpy as np

from analysis.integrity import analyze_scan

DATASET_COMMIT = "6299834614e9ae7df1e2fc5922545331b5c7f022"
SOURCE = {
    "dataset": "OpenNeuro ds000114",
    "version": "1.0.2",
    "git_commit": DATASET_COMMIT,
    "doi": "10.18112/openneuro.ds000114.v1.0.2",
    "license": "CC0-1.0",
    "authors": "Gorgolewski KJ, Storkey A, Bastin ME, Whittle IR, Wardlaw JM, Pernet CR",
    "publication": "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3641991/",
}
# Size/MD5 from immutable git-annex pointers at DATASET_COMMIT. S3's current
# objects must match this snapshot; we never silently accept a newer download.
FILES = {
    ("01", "test"): (8677710, "d6820f6cb8fb965e864419c14f6a22d5"),
    ("02", "test"): (10025785, "0e790e210a275d76e3f2f4d895df6358"),
    ("03", "test"): (7970968, "75bb38265ea96864bfa0b012ba21b0b0"),
    ("03", "retest"): (8125470, "75575589e60ce58d95b4d72d3b4bf222"),
    ("04", "test"): (9717713, "7764ef9c3fb344f69f1c2eb34cd56046"),
    ("05", "test"): (9942928, "e32c1d5fb1d6db6449b19be10b5efc67"),
    ("06", "test"): (10429286, "0dcb4734fa4f0bccc2f7b953e630e24d"),
}
SITES = {
    "a": [("01", "test"), ("02", "test")],
    "b": [("03", "test"), ("04", "test"), ("03", "retest")],
    "c": [("05", "test"), ("06", "test")],
}


def prepare_site(site, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    evidence = output / "evidence"
    manifest = {"schema_version": 1, "site_id": f"site-{site}", "acquisitions": []}
    baseline_results = []
    started = time.monotonic()
    for subject, session in SITES[site]:
        name = f"sub-{subject}_ses-{session}_T1w.nii.gz"
        source_path = output / "source" / name
        source_path.parent.mkdir(exist_ok=True)
        source_url = f"https://s3.amazonaws.com/openneuro.org/ds000114/sub-{subject}/ses-{session}/anat/{name}"
        if not source_path.exists():
            partial = source_path.with_suffix(".partial")
            try:
                with (
                    urllib.request.urlopen(source_url, timeout=60) as response,
                    partial.open("wb") as target,
                ):
                    shutil.copyfileobj(response, target)
                _verify_download(partial, FILES[(subject, session)])
                partial.replace(source_path)
            finally:
                partial.unlink(missing_ok=True)
        _verify_download(source_path, FILES[(subject, session)])
        source_sha = _sha256(source_path)
        acquisition = {
            "subject_id": f"sub-{subject}",
            "acquisition_id": f"sub-{subject}-{session}",
            "role": "selected" if session == "test" else "alternate",
            "modality": "T1w",
            "protocol_id": "ds000114-T1w",
            "path": str(source_path.relative_to(output)),
            "sha256": source_sha,
            "source": {**SOURCE, "acquisition": name, "sha256": source_sha},
            "synthetic_transformation": None,
        }
        # Verify the unmodified input before introducing a synthetic fault.
        baseline = analyze_scan(
            output,
            {**manifest, "acquisitions": [acquisition]},
            acquisition["acquisition_id"],
            evidence,
        )
        baseline_results.append(baseline)
        if not baseline["checks_passed"] or baseline["evidence"]["status"] != "ready":
            (output / "baseline-failure.json").write_text(
                json.dumps(baseline, indent=2, allow_nan=False)
            )
            raise RuntimeError(
                f"Baseline failed integrity/evidence checks: {acquisition['acquisition_id']}"
            )
        if (subject, session) in (("03", "test"), ("05", "test")):
            image = nib.as_closest_canonical(nib.load(source_path))
            data = image.get_fdata(dtype=np.float32)
            if subject == "03":
                # Fixed independently of the detector: three canonical axial
                # slices through the interior of this validated public scan.
                data[:, :, 100:103] = 0
                transformation = {
                    "type": "zero_internal_slab",
                    "axis": "RAS-z",
                    "start": 100,
                    "end_inclusive": 102,
                }
            else:
                data.fill(0)
                transformation = {"type": "zero_all_voxels"}
            derived = output / f"sub-{subject}-synthetic.nii.gz"
            nib.save(nib.Nifti1Image(data, image.affine), derived)
            acquisition.update(
                {
                    "path": derived.name,
                    "sha256": _sha256(derived),
                    "synthetic_transformation": transformation,
                }
            )
            del data, image
        manifest["acquisitions"].append(acquisition)

    results = []
    analysis_started = time.monotonic()
    for acquisition in manifest["acquisitions"]:
        result = analyze_scan(output, manifest, acquisition["acquisition_id"], evidence)
        results.append(result)
        expected = {
            "sub-03-test": "INTERNAL_BLANK_SLAB",
            "sub-05-test": "DEGENERATE_SIGNAL",
        }.get(acquisition["acquisition_id"])
        codes = [finding["code"] for finding in result["findings"]]
        if (
            codes != ([expected] if expected else [])
            or result["evidence"]["status"] != "ready"
        ):
            raise RuntimeError(
                f"Unexpected fixture result: {acquisition['acquisition_id']} {codes}"
            )
        # Blanking changes the global percentile window, so other marginal
        # slices can also be flagged. Retain them; never filter to the injection.
        if (
            expected == "INTERNAL_BLANK_SLAB"
            and [100, 102] not in result["measurements"]["blank_slab_intervals_z"]
        ):
            raise RuntimeError(
                "Synthetic slab was not localized to its recorded interval"
            )
    summary = {
        "site_id": manifest["site_id"],
        "environment": "local fixture validation, not a Freestyle benchmark",
        "download_bytes": sum(FILES[key][0] for key in SITES[site]),
        "analysis_seconds": round(time.monotonic() - analysis_started, 3),
        "preparation_seconds": round(time.monotonic() - started, 3),
        "evidence_bytes": sum(result["evidence"]["bytes"] for result in results),
        "baseline_results": baseline_results,
        "results": results,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, allow_nan=False) + "\n"
    )
    (output / "validation.json").write_text(
        json.dumps(summary, indent=2, allow_nan=False) + "\n"
    )
    return {
        key: value
        for key, value in summary.items()
        if key not in ("results", "baseline_results")
    }


def _sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verify_download(path, expected):
    size, md5 = expected
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "md5").hexdigest()
    if path.stat().st_size != size or actual != md5:
        raise RuntimeError("Public fixture does not match the pinned dataset snapshot")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", choices=SITES, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare_site(args.site, args.output), indent=2))


if __name__ == "__main__":
    main()
