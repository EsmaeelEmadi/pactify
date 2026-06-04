import type { LoggerService } from "@nestjs/common";

// ────────────────────────────────────────────────────────────
// HTTP method decorators that NestJS uses on controller methods
// ────────────────────────────────────────────────────────────

export const HTTP_METHODS = [
	"Get",
	"Post",
	"Put",
	"Patch",
	"Delete",
	"Options",
	"Head",
];

// ────────────────────────────────────────────────────────────
// Logger — consumer can override by setting `pactify.logger`
// ────────────────────────────────────────────────────────────

export const logger: { current: LoggerService | Console } = {
	current: console,
};
