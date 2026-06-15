import OpenAI from "openai";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import { logTitle } from "./utils.js";

export interface ToolCall {
    id: string;
    function: {
        name: string;
        arguments: string;
    };
}

export default class ChatOpenAI {
    private llm: OpenAI;
    private model: string;
    private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    private tools: Tool[];

    constructor(model: string, systemPrompt: string = "", tools: Tool[] = [], context: string = "") {
        this.llm = new OpenAI({
            apiKey: process.env.DASHSCOPE_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        });
        this.model = model;
        this.tools = tools;

        if (systemPrompt) {
            this.messages.push({ role: "system", content: systemPrompt });
        }

        if (context) {
            this.messages.push({ role: "user", content: context });
        }
    }

    async chat(prompt?: string): Promise<{ content: string; toolCalls: ToolCall[] }> {
        logTitle("CHAT");

        if (prompt) {
            this.messages.push({ role: "user", content: prompt });
        }

        const stream = await this.llm.chat.completions.create({
            model: this.model,
            messages: this.messages,
            stream: true,
            tools: this.getToolsDefinition(),
        });

        let content = "";
        const toolCalls: ToolCall[] = [];
        logTitle("RESPONSE");

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) {
                continue;
            }

            if (delta.content) {
                content += delta.content;
                process.stdout.write(delta.content);
            }

            if (delta.tool_calls) {
                for (const toolCallChunk of delta.tool_calls) {
                    const index = toolCallChunk.index;

                    if (!toolCalls[index]) {
                        toolCalls[index] = {
                            id: "",
                            function: {
                                name: "",
                                arguments: "",
                            },
                        };
                    }

                    const currentCall = toolCalls[index];
                    if (!currentCall) {
                        continue;
                    }

                    if (toolCallChunk.id) {
                        currentCall.id += toolCallChunk.id;
                    }

                    if (toolCallChunk.function?.name) {
                        currentCall.function.name += toolCallChunk.function.name;
                    }

                    if (toolCallChunk.function?.arguments) {
                        currentCall.function.arguments += toolCallChunk.function.arguments;
                    }
                }
            }
        }

        if (toolCalls.length > 0) {
            this.messages.push({
                role: "assistant",
                content,
                tool_calls: toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: call.function,
                })),
            });
        } else {
            this.messages.push({
                role: "assistant",
                content,
            });
        }

        return {
            content,
            toolCalls,
        };
    }

    public appendToolResult(toolCallId: string, toolOutput: string) {
        this.messages.push({
            role: "tool",
            content: toolOutput,
            tool_call_id: toolCallId,
        });
    }

    private getToolsDefinition(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return this.tools.map((tool) => {
            const fn= {
                name: tool.name,
                parameters: tool.inputSchema,
                ...(tool.description ? { description: tool.description } : {}),
            };

            return {
                type: "function",
                function: fn,
            };
        });
    }
}
