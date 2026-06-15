import type { AssistantMode, MemoryMessage, Provider, RenderMode } from "../types";
import { useAuthState, type AuthUser } from "./auth";

type AuthResponse = {
    accessToken: string;
    user: AuthUser;
};

export type ConversationSummary = {
    id: number;
    title: string;
    updatedAt: string;
    lastMessage: string | null;
};

export type PersistedMessage = {
    id: number;
    role: "user" | "assistant";
    content: string;
    status: "complete" | "streaming" | "cancelled" | "error";
};

export type AgentToolSummary = {
    serverName: string;
    name: string;
    description: string;
    inputSchema: unknown;
};

type BootstrapResponse = {
    user: AuthUser;
    conversation: { id: number; title: string } | null;
    conversations: ConversationSummary[];
    agent: {
        availableTools: AgentToolSummary[];
        error: string | null;
    };
    messages: PersistedMessage[];
};

type ConversationDetailResponse = {
    conversation: { id: number; title: string };
    messages: PersistedMessage[];
};

type ChatResponseRequest = {
    conversationId?: number | null;
    message: string;
    history: MemoryMessage[];
    mode: RenderMode;
    provider: Provider;
    assistantMode: AssistantMode;
};

const auth = useAuthState();

async function toHTTPError(response: Response) {
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    const error = new Error(payload.error ?? `HTTP ${response.status}`) as Error & {
        code?: string;
        status?: number;
    };
    error.code = payload.code;
    error.status = response.status;
    return error;
}

async function requestJSON<T>(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
        credentials: "include",
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(auth.state.accessToken
                ? {
                      Authorization: `Bearer ${auth.state.accessToken}`,
                  }
                : {}),
            ...(init.headers ?? {}),
        },
    });

    if (!response.ok) {
        throw await toHTTPError(response);
    }

    if (response.status === 204) {
        return null as T;
    }

    return (await response.json()) as T;
}

export async function register(payload: { username: string; email: string; password: string }) {
    const data = await requestJSON<AuthResponse>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload),
    });
    auth.setSession(data);
    return data;
}

export async function login(payload: { email: string; password: string }) {
    const data = await requestJSON<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
    });
    auth.setSession(data);
    return data;
}

export async function refreshSession() {
    try {
        const data = await requestJSON<AuthResponse>("/api/auth/refresh", {
            method: "POST",
            body: JSON.stringify({}),
        });
        auth.setSession(data);
        return data;
    } catch {
        auth.clearSession();
        return null;
    }
}

export async function logout() {
    await requestJSON("/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({}),
    });
    auth.clearSession();
}

export async function fetchBootstrap() {
    return requestJSON<BootstrapResponse>("/api/auth/me", {
        method: "GET",
    });
}

export async function fetchConversations() {
    return requestJSON<{ conversations: ConversationSummary[] }>("/api/conversations", {
        method: "GET",
    });
}

export async function fetchConversationDetail(conversationId: number) {
    return requestJSON<ConversationDetailResponse>(`/api/conversations/${conversationId}`, {
        method: "GET",
    });
}

export async function deleteConversation(conversationId: number) {
    return requestJSON<null>(`/api/conversations/${conversationId}`, {
        method: "DELETE",
    });
}

export async function ensureAuthenticated() {
    if (auth.state.accessToken && auth.state.user) {
        auth.markHydrated();
        return true;
    }

    const refreshed = await refreshSession();
    auth.markHydrated();
    return !!refreshed;
}

export async function openChatStream(payload: ChatResponseRequest, signal: AbortSignal) {
    let response = await fetch("/api/chat", {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(auth.state.accessToken
                ? {
                      Authorization: `Bearer ${auth.state.accessToken}`,
                  }
                : {}),
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (response.status === 401) {
        const refreshed = await refreshSession();
        if (!refreshed) {
            throw new Error("Unauthorized");
        }

        response = await fetch("/api/chat", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${auth.state.accessToken}`,
            },
            body: JSON.stringify(payload),
            signal,
        });
    }

    if (!response.ok) {
        throw await toHTTPError(response);
    }

    return response;
}
