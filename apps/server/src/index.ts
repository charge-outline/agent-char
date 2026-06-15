import { config as loadEnv } from "dotenv";
import cors from "cors";
import express from "express";
import { resolve } from "node:path";
import { setSSEHeaders, writeSSE } from "./sse.js";
import { streamByProvider } from "./streaming.js";
import type { ChatRequest, Provider, RenderMode } from "./types.js";

loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const PORT = Number(process.env.PORT ?? 3001);
const MODEL = process.env.CHAT_MODEL ?? "qwen-plus";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
    res.json({
        ok: true,
        service: "@agent-char/server",
        model: MODEL,
    });
});

app.post("/api/chat", async (req, res) => {
    const payload = (req.body ?? {}) as ChatRequest;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const mode: RenderMode = payload.mode === "buffered" ? "buffered" : "direct";
    const provider: Provider = payload.provider === "mock" ? "mock" : "live";

    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }

    let closed = false;
    req.on("aborted", () => {
        closed = true;
    });
    res.on("close", () => {
        closed = true;
    });

    setSSEHeaders(res);
    writeSSE(res, {
        type: "start",
        mode,
        model: MODEL,
        provider,
    });

    try {
        await streamByProvider({
            res,
            message,
            model: MODEL,
            provider,
            aborted: () => closed,
        });

        if (!closed) {
            writeSSE(res, { type: "done" });
            writeSSE(res, "[DONE]");
            res.end();
        }
    } catch (error) {
        if (!closed) {
            writeSSE(res, {
                type: "error",
                message: error instanceof Error ? error.message : "unknown error",
            });
            writeSSE(res, "[DONE]");
            res.end();
        }
    }
});

const server = app.listen(PORT, () => {
    console.log(`Express SSE server running at http://localhost:${PORT}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Try: PORT=${PORT + 1} pnpm dev:server`);
        return;
    }

    console.error(error);
});
