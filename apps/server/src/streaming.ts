import OpenAI from "openai";
import type { Response } from "express";
import { AppError } from "./errors.js";
import { writeSSE } from "./sse.js";
import type { MemoryMessage, Provider } from "./types.js";

const BURST_SIZE = 6;
const BURST_DELAY_MS = 18;

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockResponse(message: string) {
    return [
        "这是一个专门用于压测渲染节奏的 Mock 流。",
        `你刚才输入的是：「${message}」。`,
        "它会故意以 burst 的方式连续吐出多个 token，",
        "这样就能更直观地看到 direct 渲染和 buffer + requestAnimationFrame 合帧渲染之间的差异。",
    ].join("");
}

export async function streamMockTokens(
    res: Response,
    message: string,
    aborted: () => boolean,
    onToken?: (token: string) => void,
) {
    const tokens = Array.from(createMockResponse(message));

    for (let index = 0; index < tokens.length; index += BURST_SIZE) {
        if (aborted()) {
            return;
        }

        const burst = tokens.slice(index, index + BURST_SIZE);
        for (const token of burst) {
            onToken?.(token);
            writeSSE(res, { type: "token", content: token });
        }

        await sleep(BURST_DELAY_MS);
    }
}

export async function streamLiveTokens(
    res: Response,
    message: string,
    history: MemoryMessage[],
    model: string,
    aborted: () => boolean,
    onToken?: (token: string) => void,
) {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const baseURL = process.env.OPENAI_BASE_URL;

    if (!apiKey || !baseURL) {
        throw new AppError(
            "server_error",
            "Live provider requires DASHSCOPE_API_KEY and OPENAI_BASE_URL in the root .env file.",
        );
    }

    const client = new OpenAI({ apiKey, baseURL });
    try {
        const stream = await client.chat.completions.create({
            model,
            stream: true,
            messages: [
                {
                    role: "system",
                    content: "你是一个简洁、友好的 AI 助手。请使用自然中文回答。",
                },
                ...history.map((item) => ({
                    role: item.role,
                    content: item.content,
                })),
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

            onToken?.(token);
            writeSSE(res, { type: "token", content: token });
        }
    } catch (error) {
        const messageText = error instanceof Error ? error.message : "Upstream model request failed.";
        throw new AppError("upstream_error", messageText);
    }
}

export async function streamByProvider(options: {
    res: Response;
    message: string;
    history: MemoryMessage[];
    model: string;
    provider: Provider;
    aborted: () => boolean;
    onToken?: (token: string) => void;
}) {
    if (options.provider === "mock") {
        await streamMockTokens(
            options.res,
            options.message,
            options.aborted,
            options.onToken,
        );
        return;
    }

    await streamLiveTokens(
        options.res,
        options.message,
        options.history,
        options.model,
        options.aborted,
        options.onToken,
    );
}
