#!/usr/bin/env python3
# Langfuse ingestion smoke test for the fazer.ai agents onboarding. POSTs one OTLP span to
# /api/public/otel/v1/traces (the endpoint the app exports traces to) with HTTP Basic auth and asserts
# 200, NOT 500. This is the load-bearing
# check: a naive "test connection" hits /api/public/projects, which reads only Postgres and returns 200
# even when blob storage (MinIO/S3) is missing, masking a broken ingestion that silently drops every
# trace. The Langfuse keys come from --keys-file (JSON {publicKey, secretKey}); the secret key never
# touches argv. Python 3 stdlib only.
import argparse
import base64
import json
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Git Bash/MSYS on Windows reports paths as "/c/Users/..." (or "/mnt/c/..." under WSL), but native Python on
# Windows cannot open those: it needs "C:\Users\...". Match a leading drive segment so we can retranslate.
MSYS_DRIVE_RE = re.compile(r"^/(?:mnt/)?([A-Za-z])/(.*)$")

OTLP_PATH = "/api/public/otel/v1/traces"


def otlp_body():
    now = time.time_ns()
    span = {
        "traceId": secrets.token_hex(16),
        "spanId": secrets.token_hex(8),
        "name": "onboarding-verify",
        "kind": 1,
        "startTimeUnixNano": str(now - 1_000_000),
        "endTimeUnixNano": str(now),
        "attributes": [{"key": "langfuse.observation.type", "value": {"stringValue": "span"}}],
    }
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "langfuse-sdk"}, "spans": [span]}],
            }
        ]
    }


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def fail(msg, **extra):
    out({"ok": False, "error": msg, **extra}, code=1)


def msys_to_native(path):
    # Translate a Git Bash/MSYS/WSL path ("/c/Users/me/x", "/mnt/c/Users/me/x") to the native Windows form
    # ("C:\Users\me\x") so open() finds it. Returns None when the path is not drive-prefixed (nothing to
    # translate). POSIX paths and already-native Windows paths ("C:\...", "C:/...") are left to open() as-is.
    m = MSYS_DRIVE_RE.match(path)
    if not m:
        return None
    drive, rest = m.group(1), m.group(2)
    return f"{drive.upper()}:\\" + rest.replace("/", "\\")


def read_text_file(path, what):
    # Read a UTF-8 text file, retrying a Git Bash/MSYS path ("/c/Users/me/x") as its native Windows form when
    # the first open fails (same footgun as remote.py's --script-file). `what` names the flag for the error.
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        native = msys_to_native(path)
        if native is None:
            fail(f"cannot read {what}: {exc}")
        try:
            return Path(native).read_text(encoding="utf-8")
        except OSError as exc2:
            fail(f"cannot read {what} (tried {native!r}): {exc2}")


def cmd_ingestion(args):
    try:
        keys = json.loads(read_text_file(args.keys_file, "--keys-file"))
    except ValueError as exc:
        fail(f"--keys-file is not valid JSON (expects {{publicKey, secretKey}}): {exc}")
    public_key, secret_key = keys.get("publicKey"), keys.get("secretKey")
    if not public_key or not secret_key:
        fail("--keys-file must hold both publicKey and secretKey")
    url = args.base_url.rstrip("/") + OTLP_PATH
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(
        url,
        data=json.dumps(otlp_body()).encode("utf-8"),
        method="POST",
        headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            status, raw = resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        fail(f"request failed: {exc.reason}", url=url)
    rejected = 0
    if status == 200:
        # An OTLP 200 can still refuse spans; with one span sent, any refusal means nothing landed.
        try:
            partial = (json.loads(raw) or {}).get("partialSuccess") or {}
            rejected = int(partial.get("rejectedSpans") or 0)
        except (ValueError, TypeError, AttributeError):
            rejected = 0
    ok = status == 200 and rejected == 0
    result = {"ok": ok, "status": status, "expected": "200", "body": raw[:300]}
    if rejected:
        result["rejectedSpans"] = rejected
    if status >= 500:
        result["hint"] = "500 usually means missing MinIO/S3 blob storage (LANGFUSE_S3_* empty); traces are dropped"
    elif status in (401, 403):
        result["hint"] = "the key pair was refused: check publicKey/secretKey and that the base URL is this project's host"
    out(result, code=0 if ok else 1)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="langfuse-verify.py",
        description="Verify Langfuse ingestion actually works (200 on the OTLP endpoint, not the masked 500).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingestion", help="POST one OTLP span to /api/public/otel/v1/traces and assert 200")
    ing.add_argument("--base-url", required=True, metavar="URL", help="e.g. https://langfuse.example.com:3000")
    ing.add_argument("--keys-file", required=True, help="JSON file with {publicKey, secretKey} (chmod 600)")
    ing.add_argument("--timeout", type=int, default=30)
    ing.set_defaults(fn=cmd_ingestion)
    return parser


def main():
    args = build_parser().parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
