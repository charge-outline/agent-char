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
}

export { pool };
