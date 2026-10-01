#!/usr/bin/env python3
"""Inspect Web U-Boot, test ROM upload, or restore a whole main-area backup.

The default only performs GET requests. --upload-only only uploads to RAM.
--restore requires an interactive confirmation and uses the existing flash-all
API; it never rebuilds UBI, scrubs NAND, or uses the generic mtd write command.
"""
import argparse
import hashlib
import http.client
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit


class RecoveryError(Exception):
    pass


class Client:
    def __init__(self, url, timeout=30):
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise RecoveryError("Use the Web U-Boot URL, such as http://192.168.0.1")
        if parsed.username or parsed.password or parsed.path not in ("", "/"):
            raise RecoveryError("Use the device origin URL, without credentials or a path")
        self.host = parsed.hostname
        self.port = parsed.port
        self.https = parsed.scheme == "https"
        self.timeout = timeout

    def connect(self):
        cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
        return cls(self.host, self.port, timeout=self.timeout)

    @staticmethod
    def response(conn, path):
        response = conn.getresponse()
        data = response.read(64 * 1024)
        raw = data.decode("utf-8", errors="replace")
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            result = None
        if response.status != 200:
            detail = result.get("error", raw) if isinstance(result, dict) else raw
            raise RecoveryError(f"HTTP {response.status} {response.reason} · {path} · {detail[:1000]}")
        if not isinstance(result, dict):
            raise RecoveryError(f"{path}: expected API JSON; received {raw[:300]!r}")
        return result

    def request(self, path, payload=None):
        conn = self.connect()
        try:
            body = None if payload is None else json.dumps(payload).encode()
            conn.request("GET" if payload is None else "POST", path, body=body,
                         headers={"Content-Type": "application/json", "Cache-Control": "no-store"})
            return self.response(conn, path)
        finally:
            conn.close()

    def upload(self, rom):
        path = "/api/upload-all-flash"
        conn = self.connect()
        try:
            with rom.open("rb") as source:
                size = rom.stat().st_size
                conn.putrequest("POST", path)
                conn.putheader("Content-Type", "application/octet-stream")
                conn.putheader("Content-Length", str(size))
                conn.putheader("Connection", "close")
                conn.endheaders()
                sent = 0
                report_at = 0
                try:
                    while sent < size:
                        chunk = source.read(min(64 * 1024, size - sent))
                        if not chunk:
                            raise RecoveryError("ROM file changed or was truncated during upload")
                        conn.send(chunk)
                        sent += len(chunk)
                        if sent - report_at >= 8 * 1024 * 1024 or sent == size:
                            print(f"Upload: {sent}/{size} bytes ({sent * 100 // size}%)", flush=True)
                            report_at = sent
                except OSError as error:
                    # A server can reject the headers before receiving the ROM.
                    # Preserve its HTTP error instead of reporting only EPIPE.
                    try:
                        result = self.response(conn, path)
                    except RecoveryError:
                        raise
                    except (OSError, http.client.HTTPException):
                        raise RecoveryError(f"Upload connection failed after {sent} bytes: {error}") from error
                    raise RecoveryError(f"Server ended upload after {sent}/{size} bytes: {result}") from error
                return self.response(conn, path)
        finally:
            conn.close()


def check_rom(rom, device):
    size = rom.stat().st_size
    capacity = device.get("flash_bytes")
    if not isinstance(capacity, int) or capacity <= 0 or size != capacity:
        raise RecoveryError(f"ROM size {size} must equal Flash main-area capacity {capacity}")
    if device.get("flash_all") is False:
        raise RecoveryError("Device explicitly reports no whole-Flash restoration support")
    digest = hashlib.sha256()
    with rom.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    print(f"ROM: {rom.name} · {size} bytes · SHA-256 {digest.hexdigest()}")
    if "flash_all" not in device:
        print("Older API: restoration support is not advertised; upload response will identify endpoint errors.")


def wait_task(client, task_id, timeout):
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        time.sleep(1)
        try:
            status = client.request("/api/task")
        except (OSError, http.client.HTTPException, RecoveryError) as error:
            raise RecoveryError(f"Task status unavailable; keep the device powered and inspect it: {error}") from error
        if status.get("id") != task_id:
            raise RecoveryError("Device task changed; keep the device powered and inspect it")
        current = (status.get("phase"), status.get("output", ""))
        if current != previous:
            print(f"Phase: {current[0]}\n{current[1]}", flush=True)
            previous = current
        if status.get("state") == "done":
            if status.get("code") != 0:
                raise RecoveryError(f"Flash restore failed (code {status.get('code')}): {status.get('output', '')}")
            return
    raise RecoveryError("Timed out waiting for restoration; keep the device powered and inspect /api/task")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="current Web U-Boot origin URL")
    parser.add_argument("--rom", type=Path, help="original whole-Flash main-area .bin backup")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--upload-only", action="store_true", help="test upload into RAM; never write Flash")
    mode.add_argument("--restore", action="store_true", help="upload, confirm interactively, then restore Flash")
    parser.add_argument("--timeout", type=float, default=30, help="network timeout in seconds")
    parser.add_argument("--task-timeout", type=float, default=1800, help="maximum restoration wait in seconds")
    args = parser.parse_args()
    if (args.upload_only or args.restore) and args.rom is None:
        parser.error("--rom is required for upload/restore")
    if args.timeout <= 0 or args.task_timeout <= 0:
        parser.error("timeouts must be positive")
    client = Client(args.url, args.timeout)
    device = client.request("/api/device")
    status = client.request("/api/task")
    print(json.dumps({"device": device, "task": status}, ensure_ascii=False, indent=2))
    if not (args.upload_only or args.restore):
        return
    if status.get("busy") is not False:
        raise RecoveryError("Device is busy or has no compatible task API")
    check_rom(args.rom, device)
    if args.restore:
        print("This overwrites bootloader, firmware and board data. Do not power off during restoration.")
        print("Confirm this is a same-device main-area backup, without OOB or packed bad-block gaps.")
        if input("Type RESTORE to continue: ").strip() != "RESTORE":
            raise RecoveryError("Cancelled before upload; Flash was not written")
    uploaded = client.upload(args.rom)
    print("Upload response:", json.dumps(uploaded, ensure_ascii=False))
    upload_id = uploaded.get("upload_id")
    if type(upload_id) is not int or upload_id < 0:
        raise RecoveryError("Upload response has no valid upload_id; no Flash task was sent")
    if args.upload_only:
        print("Upload accepted into RAM. No Flash task was sent. Reboot before further testing if desired.")
        return
    # POST exactly once. A response loss may mean the write has already begun.
    # Never automatically repeat a destructive request.
    try:
        task = client.request("/api/task", {"operation": "flash-all", "upload_id": upload_id})
    except (OSError, http.client.HTTPException, RecoveryError) as error:
        raise RecoveryError(f"Cannot confirm Flash task reply. Writing may have started; "
                            f"keep the device powered and inspect /api/task: {error}") from error
    task_id = task.get("id")
    if type(task_id) is not int:
        raise RecoveryError("Task response has no valid id; inspect /api/task before continuing")
    wait_task(client, task_id, args.task_timeout)
    print("ROM restored and verified. Reboot the device manually to start the stock firmware.")


if __name__ == "__main__":
    try:
        main()
    except (RecoveryError, OSError, http.client.HTTPException, EOFError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Interrupted. If a Flash task started, keep the device powered and inspect /api/task.", file=sys.stderr)
        sys.exit(130)
