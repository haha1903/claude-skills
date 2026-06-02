#!/usr/bin/env python3
"""Pod-side helper: export a container image via crane and dump every
package manager's install list to stdout as a single JSON blob.

Not meant to be run directly by humans — batch-verify.py kubectl-cp's it
to the azure-cli pod and invokes it once per target image.

Output schema (stdout):
  {
    "image": "<image-ref>",
    "error": "<msg>"               # only if crane export failed
    "dpkg":  [{"name": str, "ver": str}, ...],
    "apk":   [{"name": str, "ver": str}, ...],
    "rpm":   [{"name": str, "ver": str}, ...],
    "java":  [{"path": str, "ga": "g:a", "ver": str}, ...],
    "node":  [{"path": str, "name": str, "ver": str}, ...]
  }

Runs inside the azure-cli pod. Requires: crane, rpm, python3, unzip.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def crane_export(image, tar_path):
    r = run(["crane", "export", image, tar_path], timeout=600)
    return r.returncode == 0, (r.stderr or "").strip().splitlines()[0] if r.stderr else ""


def parse_dpkg(fs):
    p = os.path.join(fs, "var/lib/dpkg/status")
    if not os.path.isfile(p):
        return []
    out = []
    pkg = ver = None
    with open(p, errors="ignore") as fh:
        for line in fh:
            if line.startswith("Package: "):
                pkg = line[9:].strip()
            elif line.startswith("Version: "):
                ver = line[9:].strip()
                if pkg:
                    out.append({"name": pkg, "ver": ver})
                pkg = ver = None
            elif not line.strip():
                pkg = ver = None
    return out


def parse_apk(fs):
    p = os.path.join(fs, "lib/apk/db/installed")
    if not os.path.isfile(p):
        return []
    out = []
    pkg = ver = None
    with open(p, errors="ignore") as fh:
        for line in fh:
            if line.startswith("P:"):
                pkg = line[2:].strip()
            elif line.startswith("V:"):
                ver = line[2:].strip()
                if pkg:
                    out.append({"name": pkg, "ver": ver})
            elif not line.strip():
                pkg = ver = None
    return out


def parse_rpm(fs):
    if not os.path.isdir(os.path.join(fs, "var/lib/rpm")):
        return []
    r = run(
        ["rpm", "--dbpath", os.path.join(fs, "var/lib/rpm"),
         "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\n"],
        timeout=120,
    )
    if r.returncode != 0:
        return []
    pkgs = []
    for line in r.stdout.splitlines():
        if "\t" in line:
            name, ver = line.split("\t", 1)
            pkgs.append({"name": name, "ver": ver})
    return pkgs


def parse_jars(fs):
    out = []
    pom_re = re.compile(r"META-INF/maven/([^/]+)/([^/]+)/pom\.properties$")
    for root, _, files in os.walk(fs):
        for f in files:
            if not f.endswith(".jar"):
                continue
            full = os.path.join(root, f)
            rel = full[len(fs):].lstrip("/")
            try:
                with zipfile.ZipFile(full) as z:
                    for name in z.namelist():
                        if not pom_re.match(name):
                            continue
                        data = z.read(name).decode(errors="ignore")
                        props = {}
                        for ln in data.splitlines():
                            if "=" in ln and not ln.lstrip().startswith("#"):
                                k, v = ln.split("=", 1)
                                props[k.strip()] = v.strip()
                        g = props.get("groupId")
                        a = props.get("artifactId")
                        v = props.get("version")
                        if g and a and v:
                            out.append({"path": rel, "ga": f"{g}:{a}", "ver": v})
            except (zipfile.BadZipFile, OSError, KeyError):
                continue
    return out


def parse_node(fs):
    out = []
    for root, _, files in os.walk(fs):
        if "node_modules" not in root:
            continue
        if "package.json" not in files:
            continue
        full = os.path.join(root, "package.json")
        rel = full[len(fs):].lstrip("/")
        try:
            with open(full, errors="ignore") as fh:
                pj = json.load(fh)
        except (json.JSONDecodeError, OSError):
            continue
        name = pj.get("name")
        ver = pj.get("version")
        if name and ver:
            out.append({"path": rel, "name": name, "ver": ver})
    return out


def main():
    if len(sys.argv) != 2:
        print("usage: _extract-all-deps.py <image-ref>", file=sys.stderr)
        sys.exit(2)
    image = sys.argv[1]

    result = {"image": image, "dpkg": [], "apk": [], "rpm": [], "java": [], "node": []}

    work = tempfile.mkdtemp(prefix="vdeps-")
    try:
        tar = os.path.join(work, "img.tar")
        ok, err = crane_export(image, tar)
        if not ok:
            result["error"] = f"crane: {err}"
            print(json.dumps(result))
            return
        fs = os.path.join(work, "fs")
        os.makedirs(fs, exist_ok=True)
        # Use subprocess tar so we don't materialize the whole thing in python
        r = run(["tar", "-xf", tar, "-C", fs], timeout=600)
        # Some layers have errors; don't abort on tar rc != 0
        try:
            os.unlink(tar)
        except OSError:
            pass

        result["dpkg"] = parse_dpkg(fs)
        result["apk"] = parse_apk(fs)
        result["rpm"] = parse_rpm(fs)
        result["java"] = parse_jars(fs)
        result["node"] = parse_node(fs)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
