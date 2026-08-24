from __future__ import annotations

import argparse
import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


PROTOCOL = "dsh-embedding-sidecar/1"
DEFAULT_MODEL = "intfloat/multilingual-e5-small"
DEFAULT_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
DEFAULT_DIMENSIONS = 384


def normalize(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(float(value) ** 2 for value in values))
    if not norm:
        return [float(value) for value in values]
    return [float(value) / norm for value in values]


def model_dimensions(model: Any) -> int:
    method = getattr(model, "get_embedding_dimension", None) or getattr(model, "get_sentence_embedding_dimension")
    return int(method())


class EmbeddingService:
    def __init__(self, model: Any, *, model_id: str, revision: str, device: str) -> None:
        self.model = model
        self.model_id = model_id
        self.revision = revision
        self.device = device
        self.dimensions = model_dimensions(model)
        self.lock = threading.Lock()
        self.calls = 0
        self.texts = 0

    def health(self) -> dict[str, Any]:
        return {
            "protocol": PROTOCOL,
            "status": "ready",
            "model": self.model_id,
            "revision": self.revision,
            "dimensions": self.dimensions,
            "normalized": True,
            "device": self.device,
            "calls": self.calls,
            "texts": self.texts,
        }

    def embed(self, *, kind: str, texts: list[str], batch_size: int) -> dict[str, Any]:
        if kind not in {"query", "passage"}:
            raise ValueError("kind must be query or passage")
        if not texts or len(texts) > 128 or any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("texts must contain 1..128 non-empty strings")
        prefix = "query: " if kind == "query" else "passage: "
        prepared = [text if text.startswith(prefix) else f"{prefix}{text}" for text in texts]
        with self.lock:
            encoded = self.model.encode(
                prepared,
                batch_size=max(1, min(128, int(batch_size))),
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            vectors = [normalize([float(value) for value in row]) for row in encoded]
            self.calls += 1
            self.texts += len(texts)
        if any(len(vector) != self.dimensions for vector in vectors):
            raise RuntimeError("model returned an unexpected vector dimension")
        return {
            "protocol": PROTOCOL,
            "model": self.model_id,
            "revision": self.revision,
            "dimensions": self.dimensions,
            "normalized": True,
            "vectors": vectors,
        }


def handler_for(service: EmbeddingService, batch_size: int):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DshEmbeddingSidecar/1"

        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def write_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self.write_json(404, {"protocol": PROTOCOL, "error": "not-found"})
                return
            self.write_json(200, service.health())

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/embed":
                self.write_json(404, {"protocol": PROTOCOL, "error": "not-found"})
                return
            try:
                length = int(self.headers.get("content-length") or 0)
                if length <= 0 or length > 16 * 1024 * 1024:
                    raise ValueError("invalid content length")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if payload.get("protocol") not in (None, PROTOCOL):
                    raise ValueError("protocol mismatch")
                if payload.get("model") not in (None, service.model_id):
                    raise ValueError("model mismatch")
                if payload.get("revision") not in (None, service.revision):
                    raise ValueError("revision mismatch")
                result = service.embed(
                    kind=str(payload.get("kind") or "passage"),
                    texts=list(payload.get("texts") or []),
                    batch_size=int(payload.get("batchSize") or batch_size),
                )
                self.write_json(200, result)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.write_json(400, {"protocol": PROTOCOL, "error": str(error)})
            except Exception as error:
                self.write_json(500, {"protocol": PROTOCOL, "error": f"{type(error).__name__}: {error}"})

    return Handler


def load_model(model_id: str, revision: str, cache_dir: Path, device: str):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        model_id,
        revision=revision,
        cache_folder=str(cache_dir),
        device=device,
        trust_remote_code=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Local multilingual-e5-small embedding sidecar for sensory-memory-plugin")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision", default=DEFAULT_REVISION)
    parser.add_argument("--cache-dir", default=os.environ.get("DSH_EMBEDDING_MODEL_CACHE", "E:/deepseek_memory/.models/multilingual-e5-small"))
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    device = args.device
    if device == "auto":
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_model(args.model, args.revision, cache_dir, device)
    dimensions = model_dimensions(model)
    if dimensions != DEFAULT_DIMENSIONS:
        raise RuntimeError(f"expected {DEFAULT_DIMENSIONS} dimensions, got {dimensions}")
    if args.download_only:
        print(json.dumps({"status": "downloaded", "model": args.model, "revision": args.revision, "dimensions": dimensions, "device": device}))
        return

    service = EmbeddingService(model, model_id=args.model, revision=args.revision, device=device)
    server = ThreadingHTTPServer((args.host, args.port), handler_for(service, args.batch_size))
    print(json.dumps({"status": "ready", "host": args.host, "port": args.port, **service.health()}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
