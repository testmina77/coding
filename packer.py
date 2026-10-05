#!/usr/bin/env python3

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

MSYS2_PACKAGE_BASE = "https://packages.msys2.org/packages"
MSYS2_MIRROR_BASE = "https://mirror.msys2.org"

DEFAULT_REPO = "mingw64"
DEFAULT_MAX_MIB = 45


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    print(f"  download: {url}")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "ForgeIDE-external-libs/1.0"},
    )
    with urllib.request.urlopen(request) as response:
        total = response.headers.get("Content-Length")
        total_n = int(total) if total else 0
        downloaded = 0
        with dest.open("wb") as f:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total_n:
                    percent = downloaded * 100 // total_n
                    print(
                        f"\r    {downloaded / 1024 / 1024:.1f} MiB "
                        f"/ {total_n / 1024 / 1024:.1f} MiB "
                        f"({percent}%)",
                        end="",
                        flush=True,
                    )
    if total_n:
        print()
    print(f"  saved:    {dest}")


def run_tar(args: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["tar", "--zstd", *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        die("tar not found")
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="replace")
        die(f"tar failed:\n{stderr}")


def package_page_url(package: str, repo: str) -> str:
    return f"{MSYS2_PACKAGE_BASE}/{package}?repo={repo}"


def fetch_package_page(package: str, repo: str) -> str:
    url = package_page_url(package, repo)
    print(f"  metadata: {url}")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "ForgeIDE-external-libs/1.0"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.read().decode("utf-8", errors="replace")
    except Exception as e:
        die(f"cannot fetch MSYS2 package page: {e}")


def find_package_download_url(
    package: str,
    repo: str,
) -> tuple[str, str | None]:
    html = fetch_package_page(package, repo)
    pattern = re.compile(r'https://mirror\.msys2\.org/[^"\']+\.pkg\.tar\.zst')
    match = pattern.search(html)
    if not match:
        die(f"cannot find .pkg.tar.zst URL for {package} in repo {repo}")
    url = match.group(0)
    sha_match = re.search(
        r"SHA256:\s*</?[^>]*>\s*`?([0-9a-fA-F]{64})`?",
        html,
        re.IGNORECASE,
    )
    expected_sha256 = sha_match.group(1).lower() if sha_match else None
    return url, expected_sha256


def read_pkginfo(package_file: Path) -> dict:
    result = run_tar(["-xOf", str(package_file), ".PKGINFO"])
    text = result.stdout.decode("utf-8", errors="replace")
    info = {"pkgname": None, "pkgver": None, "depends": []}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("pkgname = "):
            info["pkgname"] = line.split("=", 1)[1].strip()
        elif line.startswith("pkgver = "):
            info["pkgver"] = line.split("=", 1)[1].strip()
        elif line.startswith("depend = "):
            dependency = line.split("=", 1)[1].strip()
            info["depends"].append(dependency)
    return info


def forge_id_from_msys2_package(package: str) -> str:
    prefix = "mingw-w64-x86_64-"
    if package.startswith(prefix):
        return package[len(prefix) :]
    return package


def clean_dependency_name(name: str) -> str:
    name = re.split(r"[<>=]", name, maxsplit=1)[0]
    return name.strip()


def convert_msys2_dependency(name: str) -> str | None:
    name = clean_dependency_name(name)
    if not name:
        return None
    prefixes = (
        "mingw-w64-clang-x86_64-",
        "mingw-w64-x86_64-",
        "mingw-w64-ucrt-x86_64-",
    )
    prefix = next((p for p in prefixes if name.startswith(p)), None)
    if prefix is None:
        return None
    return name[len(prefix) :]


def extract_msys2_package(package_file: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    print(f"  extract:  {package_file.name}")
    run_tar(["-xf", str(package_file), "-C", str(destination)])


def merge_tree(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.is_dir():
            merge_tree(item, target)
            continue
        if target.exists():
            if item.is_file() and target.is_file():
                if sha256_file(item) == sha256_file(target):
                    continue
                die(f"file collision:\n  {item}\n  {target}")
            die(f"file collision: {target}")
        shutil.copy2(item, target)


def build_prefix_from_packages(
    package_files: list[Path],
    temp_root: Path,
    repo: str,
) -> tuple[Path, list[dict]]:
    merged = temp_root / "merged"
    merged.mkdir(parents=True, exist_ok=True)
    package_infos = []
    if repo == "clang64":
        toolchain_root = "clang64"
    elif repo == "ucrt64":
        toolchain_root = "ucrt64"
    elif repo == "mingw64":
        toolchain_root = "mingw64"
    else:
        raise RuntimeError(f"Unsupported MSYS2 repository: {repo}")

    for package_file in package_files:
        info = read_pkginfo(package_file)
        package_infos.append(info)
        extracted = temp_root / (
            "pkg_" + re.sub(r"[^A-Za-z0-9_.-]+", "_", package_file.stem)
        )
        extract_msys2_package(package_file, extracted)
        toolchain = extracted / toolchain_root
        if not toolchain.exists():
            raise RuntimeError(
                f"{package_file.name} does not contain /{toolchain_root}"
            )
        merge_tree(toolchain, merged)

    return merged, package_infos


def detect_include_patterns(include_root: Path) -> list[str]:
    patterns: set[str] = set()
    if not include_root.exists():
        return []
    for path in include_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(include_root).as_posix()
        parts = rel.split("/")
        if len(parts) == 1:
            patterns.add(rel)
        else:
            patterns.add(parts[0] + "/")
    return sorted(patterns)


def library_name_from_filename(filename: str) -> str | None:
    lower = filename.lower()
    if not lower.startswith("lib"):
        return None
    if not lower.endswith(".a"):
        return None
    if lower.endswith(".dll.a"):
        return None
    if len(filename) <= 5:
        return None
    return filename[3:-2]


def detect_static_libraries(lib_root: Path) -> list[str]:
    libs: set[str] = set()
    if not lib_root.exists():
        return []
    for path in lib_root.rglob("*.a"):
        if not path.is_file():
            continue
        name = library_name_from_filename(path.name)
        if name:
            libs.add(name)
    return sorted(libs)


def gzip_file(path: Path) -> bytes:
    data = path.read_bytes()
    return gzip.compress(data, compresslevel=9, mtime=0)


def write_pack(
    output_file: Path,
    entries: list[tuple[str, Path]],
) -> dict:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    index_files = {}
    offset = 0
    with output_file.open("wb") as pack:
        for rel_path, source_path in entries:
            raw = source_path.read_bytes()
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            pack.write(compressed)
            index_files[rel_path] = {
                "pack": output_file.name,
                "offset": offset,
                "compressedSize": len(compressed),
                "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
            offset += len(compressed)
    return index_files


def pack_directory(
    source_root: Path,
    output_root: Path,
    prefix: str,
    max_pack_size: int,
) -> dict:
    output_root.mkdir(parents=True, exist_ok=True)
    files = [p for p in source_root.rglob("*") if p.is_file()]
    files.sort(key=lambda p: p.relative_to(source_root).as_posix())
    pack_number = 0
    current_entries: list[tuple[str, Path, int]] = []
    current_size = 0
    all_index_files = {}

    def flush() -> None:
        nonlocal pack_number
        nonlocal current_entries
        nonlocal current_size
        if not current_entries:
            return
        pack_name = f"{prefix}-{pack_number:03d}.pack"
        pack_path = output_root / pack_name
        simple_entries = [(rel, path) for rel, path, _ in current_entries]
        index_files = write_pack(pack_path, simple_entries)
        all_index_files.update(index_files)
        print(
            f"  packed:   {pack_name} "
            f"({pack_path.stat().st_size / 1024 / 1024:.2f} MiB, "
            f"{len(current_entries)} files)"
        )
        pack_number += 1
        current_entries = []
        current_size = 0

    for source_path in files:
        rel = source_path.relative_to(source_root).as_posix()
        logical_path = f"{prefix}/{rel}"
        compressed = gzip_file(source_path)
        compressed_size = len(compressed)
        if current_entries and current_size + compressed_size > max_pack_size:
            flush()
        current_entries.append((logical_path, source_path, compressed_size))
        current_size += compressed_size

    flush()

    index = {
        "version": 1,
        "compression": "gzip",
        "maxPackSize": max_pack_size,
        "prefix": prefix,
        "files": all_index_files,
    }

    index_path = output_root / f"{prefix}.index.json"
    index_path.write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"  index:    {index_path}")
    return index


def manifest_path(root: Path) -> Path:
    return root / "manifest.json"


def load_manifest(root: Path) -> dict:
    path = manifest_path(root)
    if not path.exists():
        return {"version": 1, "target": "x86_64-w64-windows-gnu", "libraries": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        die(f"invalid {path}: {e}")
    if not isinstance(data, dict):
        die(f"invalid manifest root: {path}")
    data.setdefault("version", 1)
    data.setdefault("target", "x86_64-w64-windows-gnu")
    data.setdefault("libraries", {})
    return data


def save_manifest(root: Path, manifest: dict) -> None:
    path = manifest_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"  manifest: {path}")


def pack_external_library(
    name: str,
    source_prefix: Path,
    external_root: Path,
    explicit_libs: list[str] | None,
    dependencies: list[str],
    system_libraries: list[str],
    source_metadata: dict,
    max_pack_size: int,
) -> None:
    include_root = source_prefix / "include"
    lib_root = source_prefix / "lib"
    bin_root = source_prefix / "bin"  # ← NOWE

    if not include_root.exists():
        print("  warning: include/ not found")
    if not lib_root.exists():
        print("  warning: lib/ not found")
    if not bin_root.exists():
        print("  warning: bin/ not found")

    package_root = external_root / name
    if package_root.exists():
        shutil.rmtree(package_root)
    package_root.mkdir(parents=True, exist_ok=True)

    include_index = (
        pack_directory(include_root, package_root, "include", max_pack_size)
        if include_root.exists()
        else {
            "version": 1,
            "compression": "gzip",
            "maxPackSize": max_pack_size,
            "prefix": "include",
            "files": {},
        }
    )

    lib_index = (
        pack_directory(lib_root, package_root, "lib", max_pack_size)
        if lib_root.exists()
        else {
            "version": 1,
            "compression": "gzip",
            "maxPackSize": max_pack_size,
            "prefix": "lib",
            "files": {},
        }
    )

    # ── bin/ → runtime DLLs ──────────────────────────────────
    bin_index = (
        pack_directory(bin_root, package_root, "bin", max_pack_size)
        if bin_root.exists()
        else {
            "version": 1,
            "compression": "gzip",
            "maxPackSize": max_pack_size,
            "prefix": "bin",
            "files": {},
        }
    )

    include_patterns = detect_include_patterns(include_root)
    detected_libs = detect_static_libraries(lib_root)
    libraries = explicit_libs if explicit_libs else detected_libs

    package_manifest = {
        "id": name,
        "version": source_metadata.get("version", "unknown"),
        "target": "x86_64-w64-windows-gnu",
        "includePrefixes": include_patterns,
        "libraries": libraries,
        "dependencies": sorted(set(dependencies)),
        "systemLibraries": sorted(set(system_libraries)),
        "packs": {
            "include": "include.index.json",
            "lib": "lib.index.json",
            "bin": "bin.index.json",  # ← NOWE
        },
        "source": source_metadata,
    }

    (package_root / "package.json").write_text(
        json.dumps(package_manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manifest = load_manifest(external_root)
    manifest["libraries"][name] = package_manifest
    save_manifest(external_root, manifest)

    print()
    print(f"OK: externallibs/{name}")
    print(f"  includes: {len(include_index['files'])}")
    print(f"  libraries: {', '.join(libraries) or '(none)'}")
    print(f"  dlls: {len(bin_index['files'])}")
    print(f"  dependencies: {', '.join(dependencies) or '(none)'}")


def import_msys2(args: argparse.Namespace) -> None:
    external_root = Path(args.output).resolve()
    external_root.mkdir(parents=True, exist_ok=True)
    package_names = args.msys2_package
    if not package_names:
        die("at least one --msys2-package is required")

    with tempfile.TemporaryDirectory(prefix="forgeide-msys2-") as tmp:
        temp_root = Path(tmp)
        package_files = []
        package_infos = []
        for package_name in package_names:
            url, expected_sha256 = find_package_download_url(package_name, args.repo)
            filename = url.rsplit("/", 1)[-1]
            package_file = temp_root / filename
            download(url, package_file)
            actual_sha256 = sha256_file(package_file)
            if expected_sha256 and actual_sha256 != expected_sha256:
                die(
                    f"SHA256 mismatch for {package_name}\n"
                    f"expected: {expected_sha256}\n"
                    f"actual:   {actual_sha256}"
                )
            print(f"  sha256:   {actual_sha256}")
            package_files.append(package_file)
            info = read_pkginfo(package_file)
            package_infos.append(info)
            print(f"  package:  {info.get('pkgname') or package_name}")
            print(f"  version:  {info.get('pkgver') or 'unknown'}")

        source_prefix, infos = build_prefix_from_packages(
            package_files, temp_root, args.repo
        )

        all_msys2_deps: set[str] = set()
        for info in infos:
            for dep in info.get("depends", []):
                forge_dep = convert_msys2_dependency(dep)
                if forge_dep:
                    all_msys2_deps.add(forge_dep)

        version = next(
            (info.get("pkgver") for info in infos if info.get("pkgver")),
            "unknown",
        )
        explicit_deps = [str(x) for x in args.dep]

        metadata = {
            "provider": "msys2",
            "repository": args.repo,
            "packages": package_names,
            "versions": [info.get("pkgver") for info in package_infos],
            "msys2Dependencies": sorted(all_msys2_deps),
        }

        pack_external_library(
            name=args.name,
            source_prefix=source_prefix,
            external_root=external_root,
            explicit_libs=args.lib or None,
            dependencies=explicit_deps,
            system_libraries=args.system_lib,
            source_metadata={**metadata, "version": version},
            max_pack_size=args.max_mib * 1024 * 1024,
        )


def pack_local(args: argparse.Namespace) -> None:
    source = Path(args.source).resolve()
    if not source.exists():
        die(f"source does not exist: {source}")
    external_root = Path(args.output).resolve()
    pack_external_library(
        name=args.name,
        source_prefix=source,
        external_root=external_root,
        explicit_libs=args.lib or None,
        dependencies=args.dep,
        system_libraries=args.system_lib,
        source_metadata={"provider": "local"},
        max_pack_size=args.max_mib * 1024 * 1024,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ForgeIDE external library packer")
    sub = parser.add_subparsers(dest="command", required=True)

    msys = sub.add_parser(
        "import-msys2",
        help="download MSYS2 mingw64 packages and pack include/lib/bin",
    )
    msys.add_argument("--name", required=True)
    msys.add_argument("--msys2-package", action="append", default=[])
    msys.add_argument(
        "--repo", default=DEFAULT_REPO, choices=["mingw64", "ucrt64", "clang64"]
    )
    msys.add_argument("--output", default="externallibs")
    msys.add_argument("--lib", action="append", default=[])
    msys.add_argument("--dep", action="append", default=[])
    msys.add_argument("--system-lib", action="append", default=[])
    msys.add_argument("--max-mib", type=int, default=DEFAULT_MAX_MIB)
    msys.set_defaults(func=import_msys2)

    local = sub.add_parser("pack-local", help="pack an already prepared tree")
    local.add_argument("--name", required=True)
    local.add_argument("--source", required=True)
    local.add_argument("--output", default="externallibs")
    local.add_argument("--lib", action="append", default=[])
    local.add_argument("--dep", action="append", default=[])
    local.add_argument("--system-lib", action="append", default=[])
    local.add_argument("--max-mib", type=int, default=DEFAULT_MAX_MIB)
    local.set_defaults(func=pack_local)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
