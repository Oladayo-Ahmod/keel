#!/usr/bin/env python3
"""Local JSON-RPC proxy that retries failed upstream calls.

The matsnet RPC drops a few percent of TLS connections from some networks.
A fork test makes thousands of requests, so one drop fails the whole run.
Point forge at http://127.0.0.1:8545 instead of the public endpoint.

    python3 script/rpc_retry_proxy.py [upstream_url] [port]
"""
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = sys.argv[1] if len(sys.argv) > 1 else "https://rpc.test.mezo.org"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8545
ATTEMPTS = 8


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        last = None
        for i in range(ATTEMPTS):
            try:
                req = urllib.request.Request(
                    UPSTREAM, data=body, headers={"content-type": "application/json", "user-agent": "curl/8.5.0"}
                )
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                last = e
                time.sleep(0.3 * (i + 1))
        self.send_error(502, str(last))

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
