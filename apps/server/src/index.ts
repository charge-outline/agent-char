import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { addDays } from "./utils.js";
import {
    getRefreshCookie,
    getRefreshCookieOptions,
    hashPassword,
    issueAccessToken,
    issueRefreshToken,
    requireAuth,
    type AuthedRequest,
    verifyPassword,
    verifyRefreshToken,
} from "./auth.js";
import { config } from "./config.js";
import { initDatabase } from "./db.js";
import { AppError, isAppError } from "./errors.js";
import {
    createConversation,
    createMessage,
    createUser,
    findRefreshToken,
    findUserByEmail,
    findUserById,
    getLatestConversation,
    hashToken,
    listMessages,
    revokeRefreshToken,
    storeRefreshToken,
    touchConversation,
    updateMessage,
} from "./repositories.js";
import { setSSEHeaders, writeSSE } from "./sse.js";
import { streamByProvider } from "./streaming.js";
import type { ChatRequest, MemoryMessage, Provider, RenderMode } from "./types.js";
import { assertEmail, assertPassword, assertUsername } from "./validators.js";

const app = express();

app.use(
    cors({
        origin: config.appOrigin,
        credentials: true,
    }),
);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
    res.json({
        ok: true,
        service: "@agent-char/server",
        model: config.model,
    });
});

app.post("/api/auth/register", async (req, res, next) => {
    try {
        const username = assertUsername(String(req.body?.username ?? ""));
        const email = assertEmail(String(req.body?.email ?? ""));
        const password = assertPassword(String(req.body?.password ?? ""));

        const existingUser = await findUserByEmail(email);
        if (existingUser) {
            throw new AppError("validation_error", "An account with this email already exists.");
        }

        const passwordHash = await hashPassword(password);
        const user = await createUser({ username, email, passwordHash });
        const accessToken = issueAccessToken(user);
        const refreshToken = issueRefreshToken(user.id, crypto.randomUUID());
        await storeRefreshToken({
            userId: user.id,
            tokenHash: hashToken(refreshToken),
            expiresAt: addDays(7),
        });

        res.cookie(config.cookie.refreshName, refreshToken, getRefreshCookieOptions());
        res.status(201).json({
            accessToken,
            user,
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/auth/login", async (req, res, next) => {
    try {
        const email = assertEmail(String(req.body?.email ?? ""));
        const password = String(req.body?.password ?? "");
        const user = await findUserByEmail(email);

        if (!user || !(await verifyPassword(password, user.password_hash))) {
            throw new AppError("validation_error", "Invalid email or password.");
        }

        const publicUser = {
            id: user.id,
            username: user.username,
            email: user.email,
        };

        const accessToken = issueAccessToken(publicUser);
        const refreshToken = issueRefreshToken(user.id, crypto.randomUUID());
        await storeRefreshToken({
            userId: user.id,
            tokenHash: hashToken(refreshToken),
            expiresAt: addDays(7),
        });

        res.cookie(config.cookie.refreshName, refreshToken, getRefreshCookieOptions());
        res.json({
            accessToken,
            user: publicUser,
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/auth/refresh", async (req, res, next) => {
    try {
        const token = getRefreshCookie(req);
        if (!token) {
            throw new AppError("unauthorized_error", "Refresh token missing.");
        }

        const payload = verifyRefreshToken(token);
        const stored = await findRefreshToken(hashToken(token));
        if (!stored || stored.revoked_at || new Date(stored.expires_at).getTime() < Date.now()) {
            throw new AppError("unauthorized_error", "Refresh token expired.");
        }

        const user = await findUserById(payload.sub);
        if (!user) {
            throw new AppError("unauthorized_error", "User not found.");
        }

        const publicUser = {
            id: user.id,
            username: user.username,
            email: user.email,
        };

        const accessToken = issueAccessToken(publicUser);
        res.json({ accessToken, user: publicUser });
    } catch (error) {
        next(error);
    }
});

app.post("/api/auth/logout", async (req, res) => {
    const token = getRefreshCookie(req);
    if (token) {
        await revokeRefreshToken(hashToken(token));
    }

    res.clearCookie(config.cookie.refreshName, getRefreshCookieOptions());
    res.status(204).end();
});

app.get("/api/auth/me", requireAuth, async (req: AuthedRequest, res, next) => {
    try {
        if (!req.authUser) {
            throw new AppError("unauthorized_error", "Unauthorized");
        }

        const latestConversation = await getLatestConversation(req.authUser.id);
        const messages = latestConversation ? await listMessages(latestConversation.id) : [];

        res.json({
            user: req.authUser,
            conversation: latestConversation
                ? {
                      id: latestConversation.id,
                      title: latestConversation.title,
                  }
                : null,
            messages,
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/chat", requireAuth, async (req: AuthedRequest, res, next) => {
    if (!req.authUser) {
        next(new AppError("unauthorized_error", "Unauthorized"));
        return;
    }

    const payload = (req.body ?? {}) as ChatRequest;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    const mode: RenderMode = payload.mode === "buffered" ? "buffered" : "direct";
    const provider: Provider = payload.provider === "mock" ? "mock" : "live";
    const history: MemoryMessage[] = Array.isArray(payload.history)
        ? payload.history
              .filter(
                  (item): item is MemoryMessage =>
                      !!item &&
                      (item.role === "user" || item.role === "assistant") &&
                      typeof item.content === "string" &&
                      item.content.trim().length > 0,
              )
              .slice(-12)
        : [];

    if (!message) {
        res.status(400).json({
            error: "message is required",
            code: "validation_error",
        });
        return;
    }

    let conversationId = Number(payload.conversationId ?? 0);
    if (!conversationId) {
        const latestConversation = await getLatestConversation(req.authUser.id);
        if (latestConversation) {
            conversationId = latestConversation.id;
        } else {
            conversationId = await createConversation(req.authUser.id, message.slice(0, 48) || "New conversation");
        }
    }

    await createMessage({
        conversationId,
        role: "user",
        content: message,
        status: "complete",
    });
    const assistantMessageId = await createMessage({
        conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
    });
    await touchConversation(conversationId);

    let closed = false;
    req.on("aborted", () => {
        closed = true;
    });
    res.on("close", () => {
        closed = true;
    });

    setSSEHeaders(res);
    writeSSE(res, {
        type: "start",
        mode,
        model: config.model,
        provider,
        conversationId,
    });

    let assistantContent = "";
    try {
        await streamByProvider({
            res,
            message,
            history,
            model: config.model,
            provider,
            aborted: () => closed,
            onToken: (token) => {
                assistantContent += token;
            },
        });

        await updateMessage({
            id: assistantMessageId,
            content: assistantContent,
            status: closed ? "cancelled" : "complete",
        });

        if (!closed) {
            writeSSE(res, { type: "done" });
            writeSSE(res, "[DONE]");
            res.end();
        }
    } catch (error) {
        const appError = isAppError(error)
            ? error
            : new AppError(
                  "server_error",
                  error instanceof Error ? error.message : "unknown error",
              );
        await updateMessage({
            id: assistantMessageId,
            content: assistantContent,
            status: "error",
        });

        if (!closed) {
            writeSSE(res, {
                type: "error",
                code: appError.code,
                message: appError.message,
            });
            writeSSE(res, "[DONE]");
            res.end();
        }
    }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = isAppError(error)
        ? error
        : new AppError("server_error", error instanceof Error ? error.message : "unknown error");

    const statusCode =
        appError.code === "validation_error"
            ? 400
            : appError.code === "unauthorized_error"
              ? 401
              : appError.code === "upstream_error"
                ? 502
                : 500;
    res.status(statusCode).json({
        error: appError.message,
        code: appError.code,
    });
});

async function bootstrap() {
    await initDatabase();

    const server = app.listen(config.port, () => {
        console.log(`Express SSE server running at http://localhost:${config.port}`);
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
            console.error(
                `Port ${config.port} is already in use. Try: PORT=${config.port + 1} pnpm dev:server`,
            );
            return;
        }

        console.error(error);
    });
}

bootstrap().catch((error) => {
    console.error("Failed to bootstrap server:", error);
    process.exitCode = 1;
});
