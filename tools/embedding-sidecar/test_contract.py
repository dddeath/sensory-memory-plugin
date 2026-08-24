from __future__ import annotations

import json
import math
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from server import DEFAULT_REVISION, EmbeddingService, handler_for


class FakeRows(list):
    pass


class FakeModel:
    def get_sentence_embedding_dimension(self):
        return 3

    def encode(self, texts, **kwargs):
        rows = []
        for index, text in enumerate(texts):
            rows.append([float(len(text)), float(index + 1), 2.0])
        return FakeRows(rows)


class SidecarContractTest(unittest.TestCase):
    def setUp(self):
        self.service = EmbeddingService(FakeModel(), model_id="fixture/e5", revision=DEFAULT_REVISION, device="cpu")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.service, 8))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.base + path,
            data=data,
            headers={"content-type": "application/json"} if data else {},
            method="POST" if data else "GET",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_health_and_embed_contract(self):
        status, health = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["model"], "fixture/e5")
        status, result = self.request("/embed", {
            "protocol": "dsh-embedding-sidecar/1",
            "model": "fixture/e5",
            "revision": DEFAULT_REVISION,
            "kind": "query",
            "texts": ["alpha", "beta"],
        })
        self.assertEqual(status, 200)
        self.assertEqual(result["dimensions"], 3)
        self.assertEqual(len(result["vectors"]), 2)
        for vector in result["vectors"]:
            self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0, places=6)

    def test_rejects_model_and_kind_mismatch(self):
        with self.assertRaises(urllib.error.HTTPError) as model_error:
            self.request("/embed", {"model": "wrong", "kind": "query", "texts": ["alpha"]})
        self.assertEqual(model_error.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as kind_error:
            self.request("/embed", {"model": "fixture/e5", "kind": "other", "texts": ["alpha"]})
        self.assertEqual(kind_error.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
