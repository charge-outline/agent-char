# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "chromadb>=1.0.12",
#   "jieba>=0.42.1",
#   "openai>=1.35.0",
#   "rank-bm25>=0.2.2",
# ]
# ///

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import chromadb
import jieba
from openai import OpenAI
from rank_bm25 import BM25Okapi


ROOT_DIR = Path(__file__).resolve().parents[3]
ROOT_ENV = ROOT_DIR / ".env"
CORPUS_DIR = Path(os.environ.get("RAG_CORPUS_DIR", ROOT_DIR / "knowledge" / "nba"))
CACHE_DIR = Path(os.environ.get("RAG_CACHE_DIR", ROOT_DIR / "storage" / "rag" / "nba"))
CHROMA_DIR = Path(os.environ.get("RAG_CHROMA_DIR", ROOT_DIR / "storage" / "chroma" / "nba"))
COLLECTION_NAME = os.environ.get("RAG_COLLECTION_NAME", "nba_official_kb")
EMBEDDING_MODEL = os.environ.get("RAG_EMBEDDING_MODEL", "BAAI/bge-m3")
RERANKER_MODEL = os.environ.get("RAG_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3").strip() or None
EMBEDDING_KEY = os.environ.get("EMBEDDING_KEY", "")
EMBEDDING_BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "")

TARGET_CHARS = 650
MIN_CHARS = 260
OVERLAP_CHARS = 100
VECTOR_TOP_K = 8
BM25_TOP_K = 8
FINAL_TOP_K = 5


@dataclass
class Chunk:
    chunk_id: str
    title: str
    heading: str
    source: str
    source_url: str
    category: str
    content: str
    token_count: int
    start_offset: int
    end_offset: int


def ensure_dirs() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)


def load_root_env() -> None:
    if not ROOT_ENV.exists():
        return

    for line in ROOT_ENV.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key, value)


load_root_env()

EMBEDDING_KEY = os.environ.get("EMBEDDING_KEY", EMBEDDING_KEY)
EMBEDDING_BASE_URL = os.environ.get("EMBEDDING_BASE_URL", EMBEDDING_BASE_URL)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text

    parts = text.split("---\n", 2)
    if len(parts) < 3:
        return {}, text

    raw_meta = parts[1].strip()
    body = parts[2]
    meta: dict[str, str] = {}
    for line in raw_meta.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip()
    return meta, body


def normalize_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_into_sections(text: str) -> list[tuple[str, str]]:
    lines = text.splitlines()
    sections: list[tuple[str, str]] = []
    current_heading = "Overview"
    buffer: list[str] = []

    for line in lines:
        if line.startswith("#"):
            if buffer:
                sections.append((current_heading, "\n".join(buffer).strip()))
                buffer = []
            current_heading = line.lstrip("#").strip() or "Overview"
            continue
        buffer.append(line)

    if buffer:
        sections.append((current_heading, "\n".join(buffer).strip()))

    return [(heading, body) for heading, body in sections if body]


def tokenize(text: str) -> list[str]:
    english = re.findall(r"[A-Za-z0-9%+.-]+", text.lower())
    chinese = [token.strip() for token in jieba.cut(text, cut_all=False) if token.strip()]
    return english + chinese


def chunk_text(title: str, heading: str, source: str, source_url: str, category: str, body: str) -> list[Chunk]:
    cleaned = normalize_markdown(body)
    if not cleaned:
        return []

    segments: list[Chunk] = []
    cursor = 0
    chunk_index = 0

    while cursor < len(cleaned):
        end = min(len(cleaned), cursor + TARGET_CHARS)
        if end < len(cleaned):
            split_at = cleaned.rfind("\n", cursor, end)
            if split_at > cursor + MIN_CHARS:
                end = split_at

        piece = cleaned[cursor:end].strip()
        if piece:
            chunk_hash = hashlib.sha1(f"{title}|{heading}|{chunk_index}|{piece}".encode("utf-8")).hexdigest()[:20]
            segments.append(
                Chunk(
                    chunk_id=f"nba-{chunk_hash}",
                    title=title,
                    heading=heading,
                    source=source,
                    source_url=source_url,
                    category=category,
                    content=piece,
                    token_count=len(tokenize(piece)),
                    start_offset=cursor,
                    end_offset=end,
                )
            )
            chunk_index += 1

        if end >= len(cleaned):
            break
        cursor = max(end - OVERLAP_CHARS, cursor + 1)

    return segments


def get_embedding_client() -> OpenAI:
    if not EMBEDDING_KEY or not EMBEDDING_BASE_URL:
        raise RuntimeError("EMBEDDING_KEY and EMBEDDING_BASE_URL are required for NBA RAG ingestion/query.")
    return OpenAI(api_key=EMBEDDING_KEY, base_url=EMBEDDING_BASE_URL)


def embed_texts(texts: list[str]) -> list[list[float]]:
    client = get_embedding_client()
    response = client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [item.embedding for item in response.data]


def rerank_documents(query: str, documents: list[str]) -> list[float]:
    if not documents or not RERANKER_MODEL or not EMBEDDING_KEY or not EMBEDDING_BASE_URL:
        return [0.0 for _ in documents]

    request = urllib.request.Request(
        EMBEDDING_BASE_URL.rstrip("/") + "/rerank",
        data=json.dumps(
            {
                "model": RERANKER_MODEL,
                "query": query,
                "documents": documents,
            }
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {EMBEDDING_KEY}",
        },
        method="POST",
    )

    with urllib.request.urlopen(request) as response:
        payload = json.loads(response.read().decode("utf-8"))

    results = payload.get("results", [])
    scores = [0.0 for _ in documents]
    for item in results:
        index = int(item.get("index", -1))
        if 0 <= index < len(scores):
            scores[index] = float(item.get("relevance_score", 0.0))
    return scores


def list_markdown_files() -> list[Path]:
    return sorted(path for path in CORPUS_DIR.rglob("*.md") if path.is_file())


def build_chunks() -> list[Chunk]:
    chunks: list[Chunk] = []
    for path in list_markdown_files():
        raw = path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(raw)
        title = meta.get("title") or path.stem.replace("-", " ").title()
        source_url = meta.get("source", "")
        category = meta.get("category", path.parent.name)
        relative_source = path.relative_to(ROOT_DIR).as_posix()

        for heading, section_text in split_into_sections(body):
            chunks.extend(
                chunk_text(
                    title=title,
                    heading=heading,
                    source=relative_source,
                    source_url=source_url,
                    category=category,
                    body=section_text,
                )
            )
    return chunks


def save_manifest(chunks: list[Chunk]) -> None:
    manifest = {
        "collection_name": COLLECTION_NAME,
        "embedding_model": EMBEDDING_MODEL,
        "reranker_model": RERANKER_MODEL,
        "corpus_path": str(CORPUS_DIR),
        "chroma_path": str(CHROMA_DIR),
        "cache_path": str(CACHE_DIR),
        "document_count": len(list_markdown_files()),
        "chunk_count": len(chunks),
        "chunks": [chunk.__dict__ for chunk in chunks],
    }
    (CACHE_DIR / "chunks.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_manifest() -> dict[str, Any]:
    manifest_path = CACHE_DIR / "chunks.json"
    if not manifest_path.exists():
        raise RuntimeError("NBA knowledge manifest not found. Run the seed command first.")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def get_collection():
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    return client.get_or_create_collection(name=COLLECTION_NAME)


def command_seed() -> None:
    ensure_dirs()
    chunks = build_chunks()
    if not chunks:
        raise RuntimeError("No NBA markdown files were found to seed.")

    embeddings = embed_texts([chunk.content for chunk in chunks])
    collection = get_collection()
    collection.upsert(
        ids=[chunk.chunk_id for chunk in chunks],
        documents=[chunk.content for chunk in chunks],
        embeddings=embeddings,
        metadatas=[
            {
                "title": chunk.title,
                "heading": chunk.heading,
                "source": chunk.source,
                "source_url": chunk.source_url,
                "category": chunk.category,
                "token_count": chunk.token_count,
                "start_offset": chunk.start_offset,
                "end_offset": chunk.end_offset,
            }
            for chunk in chunks
        ],
    )
    save_manifest(chunks)
    print(
        json.dumps(
            {
                "ok": True,
                "collection_name": COLLECTION_NAME,
                "document_count": len(list_markdown_files()),
                "chunk_count": len(chunks),
                "chroma_path": str(CHROMA_DIR),
                "cache_path": str(CACHE_DIR),
                "corpus_path": str(CORPUS_DIR),
                "embedding_model": EMBEDDING_MODEL,
                "reranker_model": RERANKER_MODEL,
            },
            ensure_ascii=False,
        )
    )


def reciprocal_rank_fusion(vector_items: list[tuple[str, float]], bm25_items: list[tuple[str, float]]) -> dict[str, float]:
    fused: dict[str, float] = {}
    for rank, (chunk_id, _) in enumerate(vector_items, start=1):
        fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (60 + rank)
    for rank, (chunk_id, _) in enumerate(bm25_items, start=1):
        fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (60 + rank)
    return fused


def command_status() -> None:
    ensure_dirs()
    manifest = load_manifest()
    payload = {
        "ok": True,
        "collection_name": manifest["collection_name"],
        "document_count": manifest["document_count"],
        "chunk_count": manifest["chunk_count"],
        "chroma_path": manifest["chroma_path"],
        "cache_path": manifest["cache_path"],
        "corpus_path": manifest["corpus_path"],
        "embedding_model": manifest["embedding_model"],
        "reranker_model": manifest["reranker_model"],
    }
    print(json.dumps(payload, ensure_ascii=False))


def command_query(question: str) -> None:
    ensure_dirs()
    manifest = load_manifest()
    chunks = manifest["chunks"]
    if not chunks:
        raise RuntimeError("NBA knowledge manifest exists but contains no chunks.")

    collection = get_collection()
    query_embedding = embed_texts([question])[0]
    vector_result = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(VECTOR_TOP_K, len(chunks)),
        include=["documents", "metadatas", "distances"],
    )

    vector_ids = vector_result.get("ids", [[]])[0]
    vector_distances = vector_result.get("distances", [[]])[0]
    vector_scores = {
        chunk_id: max(0.0, 1.0 - float(distance))
        for chunk_id, distance in zip(vector_ids, vector_distances, strict=False)
    }

    tokenized_corpus = [tokenize(item["content"]) for item in chunks]
    bm25 = BM25Okapi(tokenized_corpus)
    bm25_scores_raw = bm25.get_scores(tokenize(question))
    scored_bm25 = sorted(
        [
            (item["chunk_id"], float(score))
            for item, score in zip(chunks, bm25_scores_raw, strict=False)
        ],
        key=lambda pair: pair[1],
        reverse=True,
    )[: min(BM25_TOP_K, len(chunks))]
    bm25_scores = {chunk_id: score for chunk_id, score in scored_bm25}

    vector_ranked = list(vector_scores.items())
    fused_scores = reciprocal_rank_fusion(vector_ranked, scored_bm25)

    chunk_lookup = {item["chunk_id"]: item for item in chunks}
    candidate_items = sorted(fused_scores.items(), key=lambda pair: pair[1], reverse=True)[: max(FINAL_TOP_K * 2, FINAL_TOP_K)]
    candidate_chunks = [chunk_lookup[chunk_id] for chunk_id, _ in candidate_items]
    rerank_scores = rerank_documents(question, [item["content"] for item in candidate_chunks])
    rerank_lookup = {
        candidate_chunks[index]["chunk_id"]: rerank_scores[index]
        for index in range(len(candidate_chunks))
    }

    final_items = sorted(
        candidate_items,
        key=lambda pair: (rerank_lookup.get(pair[0], 0.0), pair[1]),
        reverse=True,
    )[:FINAL_TOP_K]

    response_chunks = []
    for chunk_id, fused_score in final_items:
        item = chunk_lookup[chunk_id]
        response_chunks.append(
            {
                "chunk_id": chunk_id,
                "title": item["title"],
                "heading": item["heading"],
                "source": item["source"],
                "source_url": item["source_url"],
                "category": item["category"],
                "content": item["content"],
                "fused_score": fused_score,
                "vector_score": vector_scores.get(chunk_id, 0.0),
                "bm25_score": bm25_scores.get(chunk_id, 0.0),
                "rerank_score": rerank_lookup.get(chunk_id, 0.0),
            }
        )

    print(
        json.dumps(
            {
                "ok": True,
                "question": question,
                "chunks": response_chunks,
                "status": {
                    "collection_name": manifest["collection_name"],
                    "document_count": manifest["document_count"],
                    "chunk_count": manifest["chunk_count"],
                    "chroma_path": manifest["chroma_path"],
                    "cache_path": manifest["cache_path"],
                    "corpus_path": manifest["corpus_path"],
                    "embedding_model": manifest["embedding_model"],
                    "reranker_model": manifest["reranker_model"],
                },
            },
            ensure_ascii=False,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("seed")
    subparsers.add_parser("status")
    query_parser = subparsers.add_parser("query")
    query_parser.add_argument("--question", required=True)

    args = parser.parse_args()
    if args.command == "seed":
        command_seed()
        return
    if args.command == "status":
        command_status()
        return
    if args.command == "query":
        command_query(args.question)
        return

    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    main()
