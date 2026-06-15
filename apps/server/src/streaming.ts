import OpenAI from "openai";
import type { Response } from "express";
import type {
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from "openai/resources/chat/completions";
import { AppError } from "./errors.js";
import { getMCPManager } from "./mcp.js";
import { getNbaKnowledgeStatus, queryNbaKnowledge } from "./rag.js";
import { writeSSE } from "./sse.js";
import type { AgentEventPayload, AssistantMode, MemoryMessage, Provider } from "./types.js";

const BURST_SIZE = 6;
const BURST_DELAY_MS = 18;
const FINAL_STREAM_DELAY_MS = 8;
const MAX_AGENT_TURNS = 6;
const MAX_IDENTICAL_TOOL_CALLS = 2;

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

function createOpenAIClient() {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const baseURL = process.env.OPENAI_BASE_URL;

    if (!apiKey || !baseURL) {
        throw new AppError(
            "server_error",
            "Live provider requires DASHSCOPE_API_KEY and OPENAI_BASE_URL in the root .env file.",
        );
    }

    return new OpenAI({ apiKey, baseURL });
}

function emitAgentEvent(res: Response, payload: Omit<AgentEventPayload, "type">) {
    writeSSE(res, {
        type: "agent_event",
        ...payload,
    });
}

function serializeToolResult(result: unknown) {
    return JSON.stringify(result, null, 2);
}

function previewText(value: string, limit = 220) {
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= limit) {
        return singleLine;
    }

    return `${singleLine.slice(0, limit)}...`;
}

async function streamSyntheticTokens(
    res: Response,
    content: string,
    aborted: () => boolean,
    onToken?: (token: string) => void,
) {
    for (const token of Array.from(content)) {
        if (aborted()) {
            return;
        }

        onToken?.(token);
        writeSSE(res, { type: "token", content: token });
        await sleep(FINAL_STREAM_DELAY_MS);
    }
}

function buildBaseMessages(message: string, history: MemoryMessage[]): ChatCompletionMessageParam[] {
    return [
        {
            role: "system",
            content: [
                "你是一个简洁、友好的 AI 助手。请使用自然中文回答。",
                "当可用工具确实能帮助你获取信息、读取文件或完成任务时，可以主动调用工具。",
                "重要规则：",
                "1. 不要重复调用同一个工具并传入完全相同的参数。",
                "2. 一旦已有足够信息回答用户，就停止工具调用，直接给最终答案。",
                "3. 如果你已经知道项目根目录，不需要反复调用 list_allowed_directories。",
                "4. 分析代码时，优先使用 search_files、read_text_file、read_multiple_files 这类直接读取信息的工具。",
                "5. 如果工具结果已经说明了限制或错误，请基于现有结果解释，而不是继续死循环尝试。",
            ].join("\n"),
        },
        ...history.map((item) => ({
            role: item.role,
            content: item.content,
        })),
        {
            role: "user",
            content: message,
        },
    ];
}

function buildNbaMessages(
    message: string,
    history: MemoryMessage[],
    contextBlocks: string[],
): ChatCompletionMessageParam[] {
    const contextText =
        contextBlocks.length > 0
            ? contextBlocks.map((block, index) => `[${index + 1}] ${block}`).join("\n\n")
            : "没有检索到可用的 NBA 知识库片段。";

    return [
        {
            role: "system",
            content: [
                "你是一个专注于 NBA 的中文智能助手。",
                "优先使用提供的知识库上下文回答，必要时可以结合常识做简短解释，但不要编造具体事实。",
                "如果问题明显超出 NBA 领域，请明确告诉用户当前模式更适合回答 NBA 相关问题。",
                "如果知识库没有覆盖用户问题，请诚实说明信息不足，并建议用户换个问法或补充范围。",
                "回答尽量结构清晰，适合中文用户阅读。",
                "以下是检索到的知识库片段：",
                contextText,
            ].join("\n"),
        },
        ...history.map((item) => ({
            role: item.role,
            content: item.content,
        })),
        {
            role: "user",
            content: message,
        },
    ];
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
    const client = createOpenAIClient();

    try {
        const stream = await client.chat.completions.create({
            model,
            stream: true,
            messages: buildBaseMessages(message, history),
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

export async function streamAgentTokens(
    res: Response,
    message: string,
    history: MemoryMessage[],
    model: string,
    aborted: () => boolean,
    onToken?: (token: string) => void,
) {
    const client = createOpenAIClient();

    let manager;
    try {
        manager = await getMCPManager();
    } catch (error) {
        throw new AppError(
            "server_error",
            `MCP tools failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const toolSummaries = manager.getToolSummaries();
    if (toolSummaries.length === 0) {
        emitAgentEvent(res, {
            level: "info",
            stage: "bootstrap",
            title: "No MCP tools available",
            detail: "Agent mode requested, but no MCP tools were registered. Falling back to plain chat.",
        });
        await streamLiveTokens(res, message, history, model, aborted, onToken);
        return;
    }

    emitAgentEvent(res, {
        level: "success",
        stage: "bootstrap",
        title: "MCP tools ready",
        detail: `Loaded ${toolSummaries.length} tools: ${toolSummaries.map((tool) => tool.name).join(", ")}`,
    });

    const tools: ChatCompletionTool[] = toolSummaries.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description || `${tool.serverName} tool`,
            parameters: tool.inputSchema,
        },
    }));

    const messages: ChatCompletionMessageParam[] = buildBaseMessages(message, history);
    const toolCallCounts = new Map<string, number>();
    const executedToolSummaries: string[] = [];

    try {
        for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
            if (aborted()) {
                return;
            }

            emitAgentEvent(res, {
                level: "running",
                stage: "thinking",
                title: "Model reasoning",
                detail:
                    turn === 0
                        ? "The model is deciding whether MCP tools are needed."
                        : "The model is reviewing tool results and deciding the next step.",
            });

            const completion = await client.chat.completions.create({
                model,
                stream: false,
                messages,
                tools,
                tool_choice: "auto",
            });

            const assistantMessage = completion.choices[0]?.message;
            if (!assistantMessage) {
                throw new AppError("upstream_error", "Upstream model returned an empty assistant message.");
            }

            const toolCalls = assistantMessage.tool_calls ?? [];
            const assistantContent =
                typeof assistantMessage.content === "string" ? assistantMessage.content : "";

            const assistantForHistory: ChatCompletionAssistantMessageParam = {
                role: "assistant",
                content: assistantMessage.content ?? "",
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            };
            messages.push(assistantForHistory);

            if (toolCalls.length === 0) {
                emitAgentEvent(res, {
                    level: "success",
                    stage: "final",
                    title: "Final answer ready",
                    detail: "The model finished reasoning and is now streaming the final answer to the UI.",
                });

                await streamSyntheticTokens(
                    res,
                    assistantContent || "我已经完成这次工具调用流程，但模型没有返回可显示内容。",
                    aborted,
                    onToken,
                );
                return;
            }

            for (const toolCall of toolCalls) {
                if (toolCall.type !== "function") {
                    continue;
                }

                const toolName = toolCall.function.name;
                const rawArguments = toolCall.function.arguments || "{}";
                const dedupeKey = `${toolName}::${rawArguments}`;
                const previousCallCount = toolCallCounts.get(dedupeKey) ?? 0;

                if (previousCallCount >= MAX_IDENTICAL_TOOL_CALLS) {
                    const duplicateMessage = [
                        `Skipped duplicate tool call: ${toolName}.`,
                        "The same tool with identical arguments has already been executed enough times.",
                        "You must now use the existing tool results and provide the best possible final answer.",
                    ].join(" ");

                    emitAgentEvent(res, {
                        level: "error",
                        stage: "tool_result",
                        title: `Skipped repeated ${toolName}`,
                        detail: duplicateMessage,
                        toolName,
                    });

                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: duplicateMessage,
                    });
                    continue;
                }

                toolCallCounts.set(dedupeKey, previousCallCount + 1);
                emitAgentEvent(res, {
                    level: "running",
                    stage: "tool_call",
                    title: `Calling ${toolName}`,
                    detail: previewText(rawArguments, 320),
                    toolName,
                });

                let parsedArguments: Record<string, unknown>;
                try {
                    parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
                } catch (error) {
                    throw new AppError(
                        "server_error",
                        `Tool ${toolName} produced invalid JSON arguments: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }

                const toolResult = await manager.callTool(toolName, parsedArguments);
                const serializedResult = serializeToolResult(toolResult);
                executedToolSummaries.push(
                    `${toolName}(${previewText(rawArguments, 120)}) => ${previewText(serializedResult, 220)}`,
                );

                emitAgentEvent(res, {
                    level: "success",
                    stage: "tool_result",
                    title: `Tool ${toolName} completed`,
                    detail: previewText(serializedResult, 360),
                    toolName,
                });

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: serializedResult,
                });
            }
        }

        emitAgentEvent(res, {
            level: "info",
            stage: "final",
            title: "Iteration limit reached",
            detail:
                "The agent has reached the tool-iteration limit. It will now produce the best possible answer from the gathered tool results.",
        });

        const forcedSummary = await client.chat.completions.create({
            model,
            stream: false,
            messages: [
                ...messages,
                {
                    role: "system",
                    content: [
                        "不要再调用任何工具。",
                        "基于已有的工具结果，直接给出你当前能给出的最佳最终答案。",
                        "如果信息还不够，就明确告诉用户你已经看到了什么、还缺什么。",
                        executedToolSummaries.length > 0
                            ? `本轮已执行工具摘要：\n${executedToolSummaries.join("\n")}`
                            : "本轮没有拿到有效工具结果。",
                    ].join("\n"),
                },
            ],
            tool_choice: "none",
        });

        const finalContent =
            forcedSummary.choices[0]?.message?.content ||
            "我已经执行了一部分工具调用，但仍未完全收敛。基于现有结果，我建议缩小范围后再继续查询。";

        await streamSyntheticTokens(res, finalContent, aborted, onToken);
        return;
    } catch (error) {
        if (error instanceof AppError) {
            throw error;
        }

        throw new AppError(
            "upstream_error",
            error instanceof Error ? error.message : "Agent tool execution failed.",
        );
    }
}

export async function streamNbaTokens(
    res: Response,
    message: string,
    history: MemoryMessage[],
    model: string,
    aborted: () => boolean,
    onToken?: (token: string) => void,
) {
    const client = createOpenAIClient();
    const knowledgeStatus = await getNbaKnowledgeStatus();

    if (!("ok" in knowledgeStatus) || !knowledgeStatus.ok || !("document_count" in knowledgeStatus)) {
        throw new AppError(
            "server_error",
            "NBA knowledge base is not ready yet. Run the seed script before using NBA assistant mode.",
        );
    }

    emitAgentEvent(res, {
        level: "success",
        stage: "bootstrap",
        title: "NBA knowledge base ready",
        detail: [
            `documents: ${knowledgeStatus.document_count}`,
            `chunks: ${knowledgeStatus.chunk_count}`,
            `chroma: ${knowledgeStatus.chroma_path}`,
        ].join(" | "),
    });

    const queryResult = await queryNbaKnowledge(message);
    const contextBlocks = queryResult.chunks.map((chunk) =>
        [
            `${chunk.title}${chunk.heading ? ` / ${chunk.heading}` : ""}`,
            `source: ${chunk.source_url || chunk.source}`,
            chunk.content,
        ].join("\n"),
    );

    emitAgentEvent(res, {
        level: "success",
        stage: "tool_result",
        title: "Hybrid retrieval complete",
        detail:
            queryResult.chunks.length > 0
                ? queryResult.chunks
                      .map(
                          (chunk, index) =>
                              `#${index + 1} ${chunk.title}${chunk.heading ? ` / ${chunk.heading}` : ""}`,
                      )
                      .join(" | ")
                : "No matching NBA knowledge chunk was found.",
        references: queryResult.chunks.map((chunk) => ({
            title: chunk.title,
            heading: chunk.heading,
            source: chunk.source,
            sourceUrl: chunk.source_url,
            category: chunk.category,
            fusedScore: chunk.fused_score,
            rerankScore: chunk.rerank_score,
        })),
    });

    try {
        const stream = await client.chat.completions.create({
            model,
            stream: true,
            messages: buildNbaMessages(message, history, contextBlocks),
        });

        emitAgentEvent(res, {
            level: "running",
            stage: "final",
            title: "Streaming NBA answer",
            detail: "The model is answering with the retrieved NBA knowledge context.",
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
        const messageText = error instanceof Error ? error.message : "NBA answer generation failed.";
        throw new AppError("upstream_error", messageText);
    }
}

export async function streamByProvider(options: {
    res: Response;
    message: string;
    history: MemoryMessage[];
    model: string;
    provider: Provider;
    assistantMode: AssistantMode;
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

    if (options.assistantMode === "agent") {
        await streamAgentTokens(
            options.res,
            options.message,
            options.history,
            options.model,
            options.aborted,
            options.onToken,
        );
        return;
    }

    if (options.assistantMode === "nba") {
        await streamNbaTokens(
            options.res,
            options.message,
            options.history,
            options.model,
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
