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
    updated_at: Date | string;
    last_message: string | null;
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

export type ConversationSummary = {
    id: number;
    title: string;
    updatedAt: string;
    lastMessage: string | null;
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
        `SELECT
            c.id,
            c.user_id,
            c.title,
            c.updated_at,
            (
                SELECT m.content
                FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.id DESC
                LIMIT 1
            ) AS last_message
        FROM conversations c
        WHERE c.user_id = ?
        ORDER BY c.updated_at DESC
        LIMIT 1`,
        [userId],
    );

    return rows[0] ?? null;
}

export async function listConversations(userId: number) {
    const [rows] = await pool.query<ConversationRow[]>(
        `SELECT
            c.id,
            c.user_id,
            c.title,
            c.updated_at,
            (
                SELECT m.content
                FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.id DESC
                LIMIT 1
            ) AS last_message
        FROM conversations c
        WHERE c.user_id = ?
        ORDER BY c.updated_at DESC, c.id DESC`,
        [userId],
    );

    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt:
            row.updated_at instanceof Date
                ? row.updated_at.toISOString()
                : new Date(row.updated_at).toISOString(),
        lastMessage: row.last_message,
    })) as ConversationSummary[];
}

export async function getConversationById(userId: number, conversationId: number) {
    const [rows] = await pool.query<ConversationRow[]>(
        `SELECT
            c.id,
            c.user_id,
            c.title,
            c.updated_at,
            (
                SELECT m.content
                FROM messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.id DESC
                LIMIT 1
            ) AS last_message
        FROM conversations c
        WHERE c.id = ? AND c.user_id = ?
        LIMIT 1`,
        [conversationId, userId],
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

export async function updateConversationTitleIfDefault(conversationId: number, title: string) {
    await pool.execute(
        "UPDATE conversations SET title = ? WHERE id = ? AND title = 'New conversation'",
        [title, conversationId],
    );
}

export async function deleteConversation(userId: number, conversationId: number) {
    const [result] = await pool.execute(
        "DELETE FROM conversations WHERE id = ? AND user_id = ?",
        [conversationId, userId],
    );

    return Number((result as { affectedRows: number }).affectedRows);
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
