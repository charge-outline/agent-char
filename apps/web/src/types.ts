export type RenderMode = "direct" | "buffered";
export type Provider = "mock" | "live";

export type StartPayload = {
    type: "start";
    mode: RenderMode;
    model: string;
    provider: Provider;
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
    message: string;
};

export type SSEPayload = StartPayload | TokenPayload | DonePayload | ErrorPayload;
