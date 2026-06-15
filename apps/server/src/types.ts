export type RenderMode = "direct" | "buffered";
export type Provider = "mock" | "live";
export type AssistantMode = "chat" | "agent" | "nba";
export type ErrorCode =
    | "upstream_error"
    | "server_error"
    | "validation_error"
    | "unauthorized_error";
export type MemoryMessage = {
    role: "user" | "assistant";
    content: string;
};

export type StartPayload = {
    type: "start";
    mode: RenderMode;
    model: string;
    provider: Provider;
    conversationId: number;
    assistantMode: AssistantMode;
};

export type TokenPayload = {
    type: "token";
    content: string;
};

export type DonePayload = {
    type: "done";
};

export type ErrorPayload = {
    type: "error";
    code: ErrorCode;
    message: string;
};

export type AgentEventPayload = {
    type: "agent_event";
    level: "info" | "running" | "success" | "error";
    stage: "bootstrap" | "thinking" | "tool_call" | "tool_result" | "final";
    title: string;
    detail: string;
    toolName?: string;
    references?: Array<{
        title: string;
        heading?: string;
        source: string;
        sourceUrl?: string;
        category?: string;
        fusedScore?: number;
        rerankScore?: number;
    }>;
};

export type SSEPayload =
    | StartPayload
    | TokenPayload
    | DonePayload
    | ErrorPayload
    | AgentEventPayload;

export type ChatRequest = {
    message?: string;
    mode?: RenderMode;
    provider?: Provider;
    assistantMode?: AssistantMode;
    history?: MemoryMessage[];
    conversationId?: number;
};
