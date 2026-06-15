import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";

const PORT = Number(process.env.PORT ?? 3001);
const MODEL = process.env.CHAT_MODEL ?? "qwen-plus";
const publicDir = path.join(process.cwd(), "public");

type SSEPayload =
    | { type: "start"; mode: string; model: string; provider: "mock" | "live" }
    | { type: "token"; content: string }
    | { type: "done" }
    | { type: "error"; message: string };

const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(body: string) {
    try {
        return JSON.parse(body) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function writeSSE(res: http.ServerResponse, payload: SSEPayload | "[DONE]") {
    const data = payload === "[DONE]" ? payload : JSON.stringify(payload);
    res.write(`data: ${data}\n\n`);
}

function createMockResponse(message: string) {
    return [
        "这是一个用于演示 SSE 流式输出的假数据响应。",
        `你刚才输入的是：「${message}」。`,
        "前端会使用 ReadableStream 和 TextDecoder 逐段解析这些数据，",
        "然后分别展示“逐 token 直接渲染”和“buffer + requestAnimationFrame 合帧渲染”的区别。",
    ].join("");
}

async function streamMockTokens(
    res: http.ServerResponse,
    message: string,
    aborted: () => boolean,
) {
    const text = createMockResponse(message);
    for (const token of Array.from(text)) {
        if (aborted()) {
            return;
        }
        writeSSE(res, { type: "token", content: token });
        await sleep(1);
    }
}

async function streamModelTokens(
    res: http.ServerResponse,
    message: string,
    aborted: () => boolean,
) {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const baseURL = process.env.OPENAI_BASE_URL;

    if (!apiKey || !baseURL) {
        await streamMockTokens(res, message, aborted);
        return;
    }

    const client = new OpenAI({ apiKey, baseURL });
    const stream = await client.chat.completions.create({
        model: MODEL,
        stream: true,
        messages: [
            {
                role: "system",
                content: "你是一个简洁、友好的 AI 助手。请使用自然中文回答。",
            },
            {
                role: "user",
                content: message,
            },
        ],
    });

    for await (const chunk of stream) {
        if (aborted()) {
            return;
        }
        const token = chunk.choices[0]?.delta?.content;
        if (!token) {
            continue;
        }
        writeSSE(res, { type: "token", content: token });
    }
}

async function streamTokensByProvider(
    res: http.ServerResponse,
    message: string,
    provider: "mock" | "live",
    aborted: () => boolean,
) {
    if (provider === "mock") {
        await streamMockTokens(res, message, aborted);
        return;
    }

    await streamModelTokens(res, message, aborted);
}

async function readRequestBody(req: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await readRequestBody(req);
    const payload = safeJsonParse(body);
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    const mode = typeof payload?.mode === "string" ? payload.mode : "direct";
    const provider =
        payload?.provider === "mock" || payload?.provider === "live"
            ? payload.provider
            : "live";

    if (!message) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "message is required" }));
        return;
    }

    let closed = false;
    req.on("close", () => {
        closed = true;
    });

    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
    });

    writeSSE(res, { type: "start", mode, model: MODEL, provider });

    try {
        await streamTokensByProvider(res, message, provider, () => closed);
        if (!closed) {
            writeSSE(res, { type: "done" });
            writeSSE(res, "[DONE]");
            res.end();
        }
    } catch (error) {
        if (!closed) {
            const messageText = error instanceof Error ? error.message : "unknown error";
            writeSSE(res, { type: "error", message: messageText });
            writeSSE(res, "[DONE]");
            res.end();
        }
    }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const normalizedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(publicDir, normalizedPath);

    if (!filePath.startsWith(publicDir)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
    }

    const extension = path.extname(filePath);

    try {
        const content = await readFile(filePath);
        res.writeHead(200, {
            "Content-Type": mimeTypes[extension] ?? "text/plain; charset=utf-8",
        });
        res.end(content);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
    }
}

const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") {
        await handleChat(req, res);
        return;
    }

    if (req.method === "GET") {
        await serveStatic(req, res);
        return;
    }

    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
});

server.listen(PORT, () => {
    console.log(`SSE demo server is running at http://localhost:${PORT}`);
});
