export * from "./types.ts";
export * from "./base.ts";
export * from "./claude.ts";
export * from "./opencode.ts";
export * from "./cursor.ts";
export * from "./codex.ts";
export * from "./qwen.ts";
export * from "./droid.ts";
export * from "./composite.ts";

import { ClaudeEngine } from "./claude.ts";
import { CodexEngine } from "./codex.ts";
import { CursorEngine } from "./cursor.ts";
import { DroidEngine } from "./droid.ts";
import { OpenCodeEngine } from "./opencode.ts";
import { QwenEngine } from "./qwen.ts";
import type { AIEngine, AIEngineName } from "./types.ts";

/**
 * Create an AI engine by name
 * Accepts any string to support flexible engine combinations in supervisor mode
 */
export function createEngine(name: string): AIEngine {
	switch (name) {
		case "claude":
			return new ClaudeEngine();
		case "opencode":
			return new OpenCodeEngine();
		case "cursor":
			return new CursorEngine();
		case "codex":
			return new CodexEngine();
		case "qwen":
			return new QwenEngine();
		case "droid":
			return new DroidEngine();
		default:
			throw new Error(`Unknown AI engine: ${name}`);
	}
}

/**
 * Get the display name for an engine
 */
export function getEngineName(name: string): string {
	return createEngine(name).name;
}

/**
 * Check if an engine is available
 */
export async function isEngineAvailable(name: string): Promise<boolean> {
	return createEngine(name).isAvailable();
}
