import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db.js";
import type { MemoryMessage } from "./types.js";

type UserRow = RowDataPacket & {
    id: number;
    username: string;
    email: string;
    password_hash: string;
};

type ConversationRow = RowDataPacket & {
    id: number;
    user_id: number;
    title: string;
};

type MessageRow = RowDataPacket & {
    id: number;
    conversation_id: number;
    role: "user" | "assistant";
    content: string;
    status: "complete" | "streaming" | "cancelled" | "error";
};

export type MessageRecord = {
    id: number;
    role: "user" | "assistant";
    content: string;
    status: "complete" | "streaming" | "cancelled" | "error";
};

export function hashToken(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createUser(input: {
    username: string;
    email: string;
    passwordHash: string;
}) {
    const [result] = await pool.execute(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        [input.username, input.email, input.passwordHash],
    );

    const id = Number((result as { insertId: number }).insertId);
    return { id, username: input.username, email: input.email };
}

export async function findUserByEmail(email: string) {
    const [rows] = await pool.query<UserRow[]>(
        "SELECT id, username, email, password_hash FROM users WHERE email = ? LIMIT 1",
        [email],
    );

    return rows[0] ?? null;
}

export async function findUserById(id: number) {
    const [rows] = await pool.query<UserRow[]>(
        "SELECT id, username, email, password_hash FROM users WHERE id = ? LIMIT 1",
        [id],
    );

    return rows[0] ?? null;
}

export async function storeRefreshToken(input: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
}) {
    await pool.execute(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
        [input.userId, input.tokenHash, input.expiresAt],
    );
}

export async function findRefreshToken(tokenHash: string) {
    const [rows] = await pool.query<
        (RowDataPacket & { id: number; user_id: number; expires_at: Date; revoked_at: Date | null })[]
    >(
        "SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1",
        [tokenHash],
    );

    return rows[0] ?? null;
}

export async function revokeRefreshToken(tokenHash: string) {
    await pool.execute(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL",
        [tokenHash],
    );
}

export async function getLatestConversation(userId: number) {
    const [rows] = await pool.query<ConversationRow[]>(
        "SELECT id, user_id, title FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
        [userId],
    );

    return rows[0] ?? null;
}

export async function createConversation(userId: number, title = "New conversation") {
    const [result] = await pool.execute(
        "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
        [userId, title],
    );

    return Number((result as { insertId: number }).insertId);
}

export async function touchConversation(conversationId: number) {
    await pool.execute("UPDATE conversations SET updated_at = NOW() WHERE id = ?", [conversationId]);
}

export async function listMessages(conversationId: number) {
    const [rows] = await pool.query<MessageRow[]>(
        "SELECT id, conversation_id, role, content, status FROM messages WHERE conversation_id = ? ORDER BY id ASC",
        [conversationId],
    );

    return rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        status: row.status,
    })) as MessageRecord[];
}

export async function createMessage(input: {
    conversationId: number;
    role: "user" | "assistant";
    content: string;
    status?: "complete" | "streaming" | "cancelled" | "error";
}) {
    const [result] = await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, status) VALUES (?, ?, ?, ?)",
        [input.conversationId, input.role, input.content, input.status ?? "complete"],
    );

    return Number((result as { insertId: number }).insertId);
}

export async function updateMessage(input: {
    id: number;
    content: string;
    status: "complete" | "streaming" | "cancelled" | "error";
}) {
    await pool.execute("UPDATE messages SET content = ?, status = ? WHERE id = ?", [
        input.content,
        input.status,
        input.id,
    ]);
}

export function toMemoryHistory(messages: MessageRecord[]): MemoryMessage[] {
    return messages
        .filter((message) => message.content.trim().length > 0)
        .map((message) => ({
            role: message.role,
            content: message.content,
        }));
}
