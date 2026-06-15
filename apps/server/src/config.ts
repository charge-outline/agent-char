import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const currentFileDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(currentFileDir, "../../..");
const rootEnvPath = resolve(workspaceRoot, ".env");

loadEnv({ path: rootEnvPath });
loadEnv();

export const config = {
    port: Number(process.env.PORT ?? 3001),
    model: process.env.CHAT_MODEL ?? "qwen-plus",
    appOrigin: process.env.APP_ORIGIN ?? "http://localhost:5173",
    workspaceRoot,
    mysql: {
        host: process.env.MYSQL_HOST ?? "127.0.0.1",
        port: Number(process.env.MYSQL_PORT ?? 3306),
        user: process.env.MYSQL_USER ?? "root",
        password: process.env.MYSQL_PASSWORD ?? "",
        database: process.env.MYSQL_DATABASE ?? "agent_char",
    },
    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET ?? "dev-access-secret-change-me",
        refreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret-change-me",
        accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "7d",
    },
    cookie: {
        refreshName: "agent_char_refresh",
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax" as const,
    },
    mcp: {
        serversJson: process.env.MCP_SERVERS_JSON ?? "",
    },
    rag: {
        enabled: (process.env.RAG_ENABLED ?? "true") !== "false",
        pythonCommand: process.env.RAG_PYTHON_COMMAND ?? "uv",
        scriptPath: resolve(workspaceRoot, "apps/server/python/nba_rag.py"),
        collectionName: process.env.RAG_COLLECTION_NAME ?? "nba_official_kb",
        corpusDir: resolve(workspaceRoot, process.env.RAG_CORPUS_DIR ?? "knowledge/nba"),
        cacheDir: resolve(workspaceRoot, process.env.RAG_CACHE_DIR ?? "storage/rag/nba"),
        chromaDir: resolve(workspaceRoot, process.env.RAG_CHROMA_DIR ?? "storage/chroma/nba"),
        embeddingModel: process.env.RAG_EMBEDDING_MODEL ?? process.env.EMBEDDING_MODEL ?? "BAAI/bge-m3",
        rerankerModel: process.env.RAG_RERANKER_MODEL ?? "BAAI/bge-reranker-v2-m3",
    },
};
