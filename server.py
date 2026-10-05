#!/usr/bin/env python3
"""
ForgeIDE local dev server.

Features:
  - HTTP/1.1 with Connection: close (no hangs)
  - Range requests: bytes=a-b, bytes=a-, bytes=-n
  - 206 Partial Content, 416 Range Not Satisfiable
  - HEAD, GET, OPTIONS
  - CORS
  - Directory listing
  - Correct MIME for .wasm, .pack, .json, .js, .mjs
  - Path traversal protection
  - Threaded (concurrent .pack fetch)

Usage:
  python serve.py --port 8000 --verbose
  python serve.py --host 0.0.0.0 --port 8000 --root .
"""

from __future__ import annotations

import argparse
import html
import mimetypes
import os
import re
import socket
import sys
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_ROOT = "."

CHUNK_SIZE = 1024 * 1024  # 1 MiB

EXTRA_MIME = {
    ".wasm": "application/wasm",
    ".pack": "application/octet-stream",
    ".a": "application/octet-stream",
    ".o": "application/octet-stream",
    ".obj": "application/octet-stream",
    ".lib": "application/octet-stream",
    ".dll": "application/octet-stream",
    ".exe": "application/octet-stream",
    ".gz": "application/gzip",
    ".zst": "application/zstd",
    ".json": "application/json; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".wasm.map": "application/json; charset=utf-8",
}

RANGE_RE = re.compile(r"^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$")


# ANSI colors (disable with --no-color)
class C:
    RESET = "\033[0m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"


def color_enabled() -> bool:
    return sys.stderr.isatty()


def c(code: str, text: str) -> str:
    if not color_enabled():
        return text
    return f"{code}{text}{C.RESET}"


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────


def guess_mime(path: Path) -> str:
    name = path.name.lower()
    # Multi-suffix check (e.g. ".wasm.map")
    for ext, mime in EXTRA_MIME.items():
        if name.endswith(ext):
            return mime

    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def human_size(n: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} PiB"


def make_listing(root: Path, url_path: str) -> bytes:
    entries = []

    # Parent link
    if url_path != "/":
        entries.append('<li><a href="../">../</a></li>')

    try:
        items = sorted(
            root.iterdir(),
            key=lambda p: (p.is_file(), p.name.lower()),
        )
    except OSError:
        items = []

    for item in items:
        name = item.name
        display = name + ("/" if item.is_dir() else "")
        href = urllib.parse.quote(display)

        if url_path.endswith("/"):
            full = url_path + href
        else:
            full = url_path + "/" + href

        if item.is_dir():
            size = "-"
        else:
            try:
                size = human_size(item.stat().st_size)
            except OSError:
                size = "?"

        entries.append(
            f'<li><a href="{html.escape(full)}">'
            f"{html.escape(display)}</a> "
            f'<span class="size">{html.escape(size)}</span></li>'
        )

    body = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Index of {html.escape(url_path)}</title>
<style>
  body {{ font-family: ui-monospace, monospace; background:#111; color:#ddd; padding:1rem; }}
  a {{ color:#6cf; text-decoration:none; }}
  a:hover {{ text-decoration:underline; }}
  .size {{ color:#888; margin-left:1rem; }}
  h1 {{ font-size:1rem; }}
  ul {{ list-style:none; padding:0; }}
  li {{ padding:2px 0; }}
</style>
</head>
<body>
<h1>Index of {html.escape(url_path)}</h1>
<ul>
{chr(10).join(entries)}
</ul>
</body>
</html>
"""
    return body.encode("utf-8")


# ─────────────────────────────────────────────────────────────
# Handler
# ─────────────────────────────────────────────────────────────


class ForgeHandler(BaseHTTPRequestHandler):
    server_version = "ForgeIDE-DevServer/1.0"
    protocol_version = "HTTP/1.1"

    # Injected by serve()
    root: Path = Path(".")
    verbose: bool = False

    # ─────────────────────────────────────────────────────────
    # Logging
    # ─────────────────────────────────────────────────────────

    def log_message(self, fmt: str, *args) -> None:
        # Suppress default; we log in send_response override.
        pass

    def log_request_line(self, status: int) -> None:
        if not self.verbose:
            return

        if status < 300:
            color = C.GREEN
        elif status < 400:
            color = C.YELLOW
        else:
            color = C.RED

        line = (
            f"{c(C.DIM, self.log_date_time_string())} "
            f"{self.client_address[0]:>15} "
            f"{c(color, str(status))} "
            f"{self.command} "
            f"{self.path}"
        )

        sys.stderr.write(line + "\n")
        sys.stderr.flush()

    # ─────────────────────────────────────────────────────────
    # CORS
    # ─────────────────────────────────────────────────────────

    def _cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, HEAD, OPTIONS",
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            "Range, Content-Type, Accept, Origin, X-Requested-With",
        )
        self.send_header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )

    # ─────────────────────────────────────────────────────────
    # OPTIONS
    # ─────────────────────────────────────────────────────────

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.log_request_line(204)

    # ─────────────────────────────────────────────────────────
    # HEAD / GET
    # ─────────────────────────────────────────────────────────

    def do_HEAD(self) -> None:
        try:
            self._serve(send_body=False)
        except Exception as e:
            self._safe_error(500, f"{e!r}")

    def do_GET(self) -> None:
        try:
            self._serve(send_body=True)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._safe_error(500, f"{e!r}")

    # ─────────────────────────────────────────────────────────
    # Path resolution
    # ─────────────────────────────────────────────────────────

    def _resolve(self) -> Path | None:
        # Strip query string and fragment.
        raw = self.path
        q = raw.find("?")
        if q != -1:
            raw = raw[:q]
        h = raw.find("#")
        if h != -1:
            raw = raw[:h]

        rel = urllib.parse.unquote(raw)

        # Strip leading slashes.
        rel = rel.lstrip("/")

        # Normalize separators.
        rel = rel.replace("\\", "/")

        if not rel:
            rel = "."

        # Resolve and make sure it's inside root.
        try:
            root = self.root.resolve()
            target = (root / rel).resolve()
            target.relative_to(root)
        except (ValueError, OSError):
            return None

        return target

    # ─────────────────────────────────────────────────────────
    # Main serve
    # ─────────────────────────────────────────────────────────

    def _serve(self, send_body: bool) -> None:
        target = self._resolve()

        if target is None:
            self._safe_error(403, "Forbidden")
            return

        if not target.exists():
            self._safe_error(404, "Not Found")
            return

        if target.is_dir():
            self._serve_dir(target, send_body=send_body)
            return

        self._serve_file(target, send_body=send_body)

    # ─────────────────────────────────────────────────────────
    # Directory
    # ─────────────────────────────────────────────────────────

    def _serve_dir(self, target: Path, send_body: bool) -> None:
        # Redirect to trailing slash.
        raw = self.path
        q = raw.find("?")
        path_only = raw[:q] if q != -1 else raw

        if not path_only.endswith("/"):
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self._cors_headers()
            self.send_header("Location", path_only + "/")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.log_request_line(301)
            return

        index = target / "index.html"

        if index.is_file():
            self._serve_file(index, send_body=send_body)
            return

        body = make_listing(target, path_only)

        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        if send_body:
            self.wfile.write(body)

        self.log_request_line(200)

    # ─────────────────────────────────────────────────────────
    # File
    # ─────────────────────────────────────────────────────────

    def _serve_file(self, target: Path, send_body: bool) -> None:
        try:
            size = target.stat().st_size
        except OSError:
            self._safe_error(500, "Cannot stat file")
            return

        mime = guess_mime(target)

        range_header = self.headers.get("Range")

        start = 0
        end = size - 1
        is_range = False

        if range_header:
            parsed = self._parse_range(range_header, size)

            if parsed is None:
                # 416
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self._cors_headers()
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Connection", "close")
                self.end_headers()
                self.log_request_line(416)
                return

            start, end = parsed
            is_range = True

        length = max(0, end - start + 1)

        # Status
        if is_range:
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
        else:
            self.send_response(HTTPStatus.OK)

        self._cors_headers()
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")

        if is_range:
            self.send_header(
                "Content-Range",
                f"bytes {start}-{end}/{size}",
            )

        self.send_header("Cache-Control", "no-cache")
        self.send_header(
            "Last-Modified", self.date_time_string(int(target.stat().st_mtime))
        )
        # Critical: close so HTTP/1.1 clients don't hang.
        self.send_header("Connection", "close")
        self.end_headers()

        if not send_body:
            self.log_request_line(206 if is_range else 200)
            return

        # Body
        try:
            with target.open("rb") as f:
                f.seek(start)

                remaining = length

                while remaining > 0:
                    chunk = f.read(min(CHUNK_SIZE, remaining))

                    if not chunk:
                        break

                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

        self.log_request_line(206 if is_range else 200)

    # ─────────────────────────────────────────────────────────
    # Range parsing
    # ─────────────────────────────────────────────────────────

    def _parse_range(
        self,
        header: str,
        size: int,
    ) -> tuple[int, int] | None:
        if size <= 0:
            return None

        m = RANGE_RE.match(header)

        if not m:
            return None

        start_s, end_s = m.group(1), m.group(2)

        if start_s == "" and end_s == "":
            return None

        if start_s == "":
            # Suffix: last N bytes
            try:
                n = int(end_s)
            except ValueError:
                return None

            if n <= 0:
                return None

            n = min(n, size)
            return (size - n, size - 1)

        try:
            start = int(start_s)
        except ValueError:
            return None

        if start >= size:
            return None

        if end_s == "":
            end = size - 1
        else:
            try:
                end = int(end_s)
            except ValueError:
                return None

            if end < start:
                return None

            end = min(end, size - 1)

        return (start, end)

    # ─────────────────────────────────────────────────────────
    # Errors
    # ─────────────────────────────────────────────────────────

    def _safe_error(self, code: int, message: str) -> None:
        try:
            self._error(code, message)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, code: int, message: str) -> None:
        body = f"{code} {message}\n".encode("utf-8")

        self.send_response(code)
        self._cors_headers()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

        self.log_request_line(code)


# ─────────────────────────────────────────────────────────────
# Server
# ─────────────────────────────────────────────────────────────


class ForgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address) -> None:
        # Suppress noisy tracebacks on client disconnect.
        exc = sys.exc_info()[1]

        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return

        super().handle_error(request, client_address)


def serve(
    host: str,
    port: int,
    root: Path,
    verbose: bool,
) -> None:
    ForgeHandler.root = root
    ForgeHandler.verbose = verbose

    try:
        httpd = ForgeServer((host, port), ForgeHandler)
    except OSError as e:
        print(f"error: cannot bind {host}:{port}: {e}", file=sys.stderr)
        sys.exit(1)

    print("ForgeIDE dev server")
    print(f"  root:    {root}")
    print(f"  listen:  http://{host}:{port}/")
    print()
    print("Endpoints:")
    print(f"  http://{host}:{port}/index.html")
    print(f"  http://{host}:{port}/worker.js")
    print(f"  http://{host}:{port}/sysroot/")
    print(f"  http://{host}:{port}/externallibs/")
    print(f"  http://{host}:{port}/externallibs/manifest.json")
    print(f"  http://{host}:{port}/bin/clang.wasm")
    print(f"  http://{host}:{port}/bin/lld.wasm")
    print(f"  http://{host}:{port}/builtins/")
    print()
    print("Range test:")
    print(
        f'  curl -v -H "Range: bytes=0-1023" '
        f"http://{host}:{port}/externallibs/curl/include-000.pack"
    )
    print()
    print("Ctrl+C to stop.")
    print()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        httpd.server_close()


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ForgeIDE local dev server",
    )

    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"bind address (default: {DEFAULT_HOST})",
    )

    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"port (default: {DEFAULT_PORT})",
    )

    parser.add_argument(
        "--root",
        default=DEFAULT_ROOT,
        help=f"document root (default: {DEFAULT_ROOT})",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="log every request",
    )

    parser.add_argument(
        "--no-color",
        action="store_true",
        help="disable ANSI colors in logs",
    )

    args = parser.parse_args()

    if args.no_color:
        # Monkey-patch color_enabled
        global color_enabled
        color_enabled = lambda: False  # type: ignore

    root = Path(args.root).resolve()

    if not root.is_dir():
        print(f"error: root is not a directory: {root}", file=sys.stderr)
        sys.exit(1)

    serve(
        host=args.host,
        port=args.port,
        root=root,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
