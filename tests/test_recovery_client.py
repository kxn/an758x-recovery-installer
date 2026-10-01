import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "tools/recovery-client.py"
spec = importlib.util.spec_from_file_location("recovery_client", SCRIPT)
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)


class RecoveryClientTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.reject_upload = False
        self.fail_write = False
        self.fail_task_response = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                owner.requests.append(("GET", self.path))
                if self.path == "/api/device":
                    self.reply(200, {"model": "Nokia XG-040G-MF", "flash_bytes": 8, "ram_bytes": 512,
                                     "flash_all": True})
                elif self.path == "/api/task":
                    self.reply(200, {"id": 11, "busy": False, "state": "done",
                                     "code": 1 if owner.fail_write else 0, "phase": "verify",
                                     "output": "verify failed at 0x20000" if owner.fail_write else "verified"})
                else:
                    self.reply(404, {"error": "unknown API"})

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                owner.requests.append(("POST", self.path, body))
                if self.path == "/api/upload-all-flash":
                    if owner.reject_upload:
                        self.reply(400, {"error": "Cannot reserve contiguous RAM"})
                    else:
                        self.reply(200, {"upload_id": 7})
                elif self.path == "/api/task":
                    if owner.fail_task_response:
                        self.connection.close()
                    else:
                        self.reply(200, {"id": 11})
                else:
                    self.reply(404, {"error": "unknown API"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.temp = tempfile.TemporaryDirectory()
        self.rom = Path(self.temp.name) / "rom.bin"
        self.rom.write_bytes(b"stockrom")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_client(self, *args, stdin=""):
        return subprocess.run([sys.executable, str(SCRIPT), self.url, *args],
                              input=stdin, text=True, capture_output=True, timeout=10)

    def test_default_only_reads(self):
        result = self.run_client()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests, [("GET", "/api/device"), ("GET", "/api/task")])

    def test_upload_only_never_sends_flash_task(self):
        result = self.run_client("--rom", str(self.rom), "--upload-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        posts = [request for request in self.requests if request[0] == "POST"]
        self.assertEqual(posts, [("POST", "/api/upload-all-flash", b"stockrom")])

    def test_wrong_size_rejected_without_upload(self):
        self.rom.write_bytes(b"short")
        result = self.run_client("--rom", str(self.rom), "--upload-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(request[0] == "POST" for request in self.requests))

    def test_cancel_before_upload(self):
        result = self.run_client("--rom", str(self.rom), "--restore", stdin="no\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(request[0] == "POST" for request in self.requests))

    def test_upload_error_preserves_http_status_and_reason(self):
        self.reject_upload = True
        result = self.run_client("--rom", str(self.rom), "--restore", stdin="RESTORE\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 400", result.stderr)
        self.assertIn("/api/upload-all-flash", result.stderr)
        self.assertIn("contiguous RAM", result.stderr)
        self.assertFalse(any(request[0:2] == ("POST", "/api/task") for request in self.requests))

    def test_restore_uses_only_flash_all_then_verifies(self):
        result = self.run_client("--rom", str(self.rom), "--restore", stdin="RESTORE\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        tasks = [json.loads(request[2]) for request in self.requests if request[0:2] == ("POST", "/api/task")]
        self.assertEqual(tasks, [{"operation": "flash-all", "upload_id": 7}])
        self.assertIn("restored and verified", result.stdout)

    def test_write_error_keeps_failing_offset(self):
        self.fail_write = True
        result = self.run_client("--rom", str(self.rom), "--restore", stdin="RESTORE\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("0x20000", result.stderr)

    def test_lost_task_reply_is_not_retried(self):
        self.fail_task_response = True
        result = self.run_client("--rom", str(self.rom), "--restore", stdin="RESTORE\n")
        self.assertNotEqual(result.returncode, 0)
        tasks = [request for request in self.requests if request[0:2] == ("POST", "/api/task")]
        self.assertEqual(len(tasks), 1)

    def test_large_file_early_404_is_not_hidden_by_broken_pipe(self):
        owner = self

        class RejectImmediately(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                owner.requests.append(("POST", self.path))
                data = b'{"error":"unknown API"}'
                self.send_response(404)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
                self.wfile.flush()
                self.close_connection = True

        server = ThreadingHTTPServer(("127.0.0.1", 0), RejectImmediately)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.rom.open("wb") as stream:
                stream.truncate(32 * 1024 * 1024)
            client = client_module.Client(f"http://127.0.0.1:{server.server_port}")
            with self.assertRaisesRegex(client_module.RecoveryError, "HTTP 404.*unknown API"):
                client.upload(self.rom)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
