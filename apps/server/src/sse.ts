import type { Response } from "express";
import type { SSEPayload } from "./types.js";

export function setSSEHeaders(res: Response) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
}

export function writeSSE(res: Response, payload: SSEPayload | "[DONE]") {
    const data = payload === "[DONE]" ? payload : JSON.stringify(payload);
    res.write(`data: ${data}\n\n`);
}
