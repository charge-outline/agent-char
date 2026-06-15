import type { ErrorCode } from "./types.js";

export class AppError extends Error {
    code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(message);
        this.name = "AppError";
        this.code = code;
    }
}

export function isAppError(error: unknown): error is AppError {
    return error instanceof AppError;
}
