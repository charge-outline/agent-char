import type { MemoryMessage, Provider, RenderMode } from "../types";
import { useAuthState, type AuthUser } from "./auth";

type AuthResponse = {
    accessToken: string;
    user: AuthUser;
};

type BootstrapResponse = {
    user: AuthUser;
    conversation: { id: number; title: string } | null;
    messages: {
        id: number;
        role: "user" | "assistant";
        content: string;
        status: "complete" | "streaming" | "cancelled" | "error";
    }[];
};

type ChatResponseRequest = {
    conversationId?: number | null;
    message: string;
    history: MemoryMessage[];
    mode: RenderMode;
    provider: Provider;
};

const auth = useAuthState();

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
        const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        const error = new Error(payload.error ?? `HTTP ${response.status}`) as Error & {
            code?: string;
            status?: number;
        };
        error.code = payload.code;
        error.status = response.status;
        throw error;
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
    const response = await fetch("/api/chat", {
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

        return fetch("/api/chat", {
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

    return response;
}
