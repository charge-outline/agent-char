import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import type { SignOptions } from "jsonwebtoken";
import { AppError } from "./errors.js";
import { config } from "./config.js";

type AccessTokenPayload = {
    sub: number;
    email: string;
    username: string;
    type: "access";
};

type RefreshTokenPayload = {
    sub: number;
    sessionId: string;
    type: "refresh";
};

export type AuthUser = {
    id: number;
    username: string;
    email: string;
};

export type AuthedRequest = Request & {
    authUser?: AuthUser;
};

export function hashPassword(password: string) {
    return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string) {
    return bcrypt.compare(password, hash);
}

export function issueAccessToken(user: AuthUser) {
    const payload: AccessTokenPayload = {
        sub: user.id,
        email: user.email,
        username: user.username,
        type: "access",
    };

    const options: SignOptions = {
        expiresIn: config.jwt.accessExpiresIn as NonNullable<SignOptions["expiresIn"]>,
    };

    return jwt.sign(payload, config.jwt.accessSecret, options);
}

export function issueRefreshToken(userId: number, sessionId: string) {
    const payload: RefreshTokenPayload = {
        sub: userId,
        sessionId,
        type: "refresh",
    };

    const options: SignOptions = {
        expiresIn: config.jwt.refreshExpiresIn as NonNullable<SignOptions["expiresIn"]>,
    };

    return jwt.sign(payload, config.jwt.refreshSecret, options);
}

export function verifyAccessToken(token: string) {
    return jwt.verify(token, config.jwt.accessSecret) as unknown as AccessTokenPayload;
}

export function verifyRefreshToken(token: string) {
    return jwt.verify(token, config.jwt.refreshSecret) as unknown as RefreshTokenPayload;
}

export function getRefreshCookieOptions(): CookieOptions {
    return {
        httpOnly: true,
        secure: config.cookie.secure,
        sameSite: config.cookie.sameSite,
        path: "/api/auth",
    };
}

export function getBearerToken(req: Request) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        return null;
    }

    return header.slice("Bearer ".length);
}

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
    try {
        const token = getBearerToken(req);
        if (!token) {
            throw new AppError("unauthorized_error", "Missing access token.");
        }

        const payload = verifyAccessToken(token);
        req.authUser = {
            id: payload.sub,
            email: payload.email,
            username: payload.username,
        };
        next();
    } catch {
        next(new AppError("unauthorized_error", "Unauthorized"));
    }
}

export function getRefreshCookie(req: Request) {
    return req.cookies?.[config.cookie.refreshName] as string | undefined;
}
