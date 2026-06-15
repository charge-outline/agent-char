import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { AppError } from "./errors.js";

export type NbaKnowledgeChunk = {
    chunk_id: string;
    title: string;
    heading: string;
    source: string;
    source_url: string;
    category: string;
    content: string;
    fused_score: number;
    vector_score: number;
    bm25_score: number;
    rerank_score: number;
};

export type NbaKnowledgeQueryResult = {
    ok: boolean;
    question: string;
    chunks: NbaKnowledgeChunk[];
    status: {
        collection_name: string;
        chroma_path: string;
        cache_path: string;
        corpus_path: string;
        embedding_model: string;
        reranker_model: string | null;
        document_count: number;
        chunk_count: number;
    };
};

type ScriptCommand = "seed" | "query" | "status";

function createRagEnv() {
    return {
        ...process.env,
        RAG_COLLECTION_NAME: config.rag.collectionName,
        RAG_CHROMA_DIR: config.rag.chromaDir,
        RAG_CACHE_DIR: config.rag.cacheDir,
        RAG_CORPUS_DIR: config.rag.corpusDir,
        RAG_EMBEDDING_MODEL: config.rag.embeddingModel,
        RAG_RERANKER_MODEL: config.rag.rerankerModel,
        EMBEDDING_KEY: process.env.EMBEDDING_KEY ?? "",
        EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL ?? "",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
    };
}

async function ensureRagDirs() {
    await Promise.all([
        mkdir(config.rag.cacheDir, { recursive: true }),
        mkdir(config.rag.chromaDir, { recursive: true }),
    ]);
}

function runPythonScript(command: ScriptCommand, extraArgs: string[] = []) {
    return new Promise<string>((resolve, reject) => {
        const args =
            config.rag.pythonCommand === "uv"
                ? ["run", config.rag.scriptPath, command, ...extraArgs]
                : [config.rag.scriptPath, command, ...extraArgs];
        const child = spawn(config.rag.pythonCommand, args, {
            cwd: config.workspaceRoot,
            env: createRagEnv(),
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            reject(error);
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        stderr.trim() ||
                            stdout.trim() ||
                            `NBA RAG script exited with code ${code ?? "unknown"}.`,
                    ),
                );
                return;
            }

            resolve(stdout.trim());
        });
    });
}

export async function queryNbaKnowledge(question: string) {
    if (!config.rag.enabled) {
        throw new AppError("server_error", "NBA knowledge assistant is disabled by configuration.");
    }

    await ensureRagDirs();

    try {
        const payloadText = await runPythonScript("query", ["--question", question]);
        return JSON.parse(payloadText) as NbaKnowledgeQueryResult;
    } catch (error) {
        throw new AppError(
            "server_error",
            `NBA knowledge retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

export async function getNbaKnowledgeStatus() {
    if (!config.rag.enabled) {
        return {
            ok: false,
            disabled: true,
        };
    }

    await ensureRagDirs();

    try {
        const payloadText = await runPythonScript("status");
        return JSON.parse(payloadText) as NbaKnowledgeQueryResult["status"] & { ok: true };
    } catch (error) {
        return {
            ok: false,
            disabled: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
