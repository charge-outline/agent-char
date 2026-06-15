import { AppError } from "./errors.js";

export function assertEmail(email: string) {
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new AppError("validation_error", "Please provide a valid email address.");
    }
    return value;
}

export function assertPassword(password: string) {
    if (password.length < 6) {
        throw new AppError("validation_error", "Password must be at least 6 characters.");
    }
    return password;
}

export function assertUsername(username: string) {
    const value = username.trim();
    if (value.length < 2) {
        throw new AppError("validation_error", "Username must be at least 2 characters.");
    }
    return value;
}
