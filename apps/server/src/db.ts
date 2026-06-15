import mysql from "mysql2/promise";
import { config } from "./config.js";

const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
});

export async function initDatabase() {
    const bootstrap = await mysql.createConnection({
        host: config.mysql.host,
        port: config.mysql.port,
        user: config.mysql.user,
        password: config.mysql.password,
    });

    await bootstrap.query(
        `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await bootstrap.end();

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(80) NOT NULL,
            email VARCHAR(191) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            user_id BIGINT UNSIGNED NOT NULL,
            token_hash VARCHAR(255) NOT NULL,
            expires_at DATETIME NOT NULL,
            revoked_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_refresh_tokens_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS conversations (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            user_id BIGINT UNSIGNED NOT NULL,
            title VARCHAR(191) NOT NULL DEFAULT 'New conversation',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_conversations_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            conversation_id BIGINT UNSIGNED NOT NULL,
            role ENUM('user', 'assistant') NOT NULL,
            content LONGTEXT NOT NULL,
            status ENUM('complete', 'streaming', 'cancelled', 'error') NOT NULL DEFAULT 'complete',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            CONSTRAINT fk_messages_conversation
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_bases (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            slug VARCHAR(80) NOT NULL UNIQUE,
            name VARCHAR(120) NOT NULL,
            description TEXT NULL,
            provider VARCHAR(40) NOT NULL DEFAULT 'local',
            storage_path VARCHAR(255) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            knowledge_base_id BIGINT UNSIGNED NOT NULL,
            slug VARCHAR(160) NOT NULL,
            title VARCHAR(255) NOT NULL,
            source_url VARCHAR(500) NULL,
            source_type VARCHAR(40) NOT NULL DEFAULT 'markdown',
            content_hash VARCHAR(64) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_kb_document_slug (knowledge_base_id, slug),
            CONSTRAINT fk_knowledge_documents_base
                FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id)
                ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            knowledge_base_id BIGINT UNSIGNED NOT NULL,
            document_id BIGINT UNSIGNED NOT NULL,
            chunk_key VARCHAR(191) NOT NULL,
            heading VARCHAR(255) NULL,
            token_count INT UNSIGNED NOT NULL DEFAULT 0,
            start_offset INT UNSIGNED NOT NULL DEFAULT 0,
            end_offset INT UNSIGNED NOT NULL DEFAULT 0,
            metadata_json JSON NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_chunk_key (chunk_key),
            KEY idx_knowledge_chunks_document (document_id),
            CONSTRAINT fk_knowledge_chunks_base
                FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_knowledge_chunks_document
                FOREIGN KEY (document_id) REFERENCES knowledge_documents(id)
                ON DELETE CASCADE
        )
    `);

    await pool.execute(
        `INSERT INTO knowledge_bases (slug, name, description, provider, storage_path)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            description = VALUES(description),
            provider = VALUES(provider),
            storage_path = VALUES(storage_path)`,
        [
            "nba",
            "NBA Knowledge Assistant",
            "Hybrid retrieval corpus for NBA rules, glossary, history, teams and player archetypes.",
            "chroma",
            config.rag.chromaDir,
        ],
    );
}

export { pool };
