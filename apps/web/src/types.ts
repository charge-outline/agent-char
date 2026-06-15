export type RenderMode = "direct" | "buffered";
export type Provider = "mock" | "live";
export type ErrorCode =
    | "upstream_error"
    | "server_error"
    | "validation_error"
    | "unauthorized_error"
    | "network_error";
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

export type SSEPayload = StartPayload | TokenPayload | DonePayload | ErrorPayload;
