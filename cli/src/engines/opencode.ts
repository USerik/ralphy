import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaseAIEngine, checkForErrors, execCommand } from "./base.ts";
import type { AIResult, EngineOptions } from "./types.ts";

/**
 * OpenCode AI Engine
 */
export class OpenCodeEngine extends BaseAIEngine {
	name = "OpenCode";
	cliCommand = "opencode";

	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		const args = ["run", "--format", "json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}

		// Write prompt to temp file to avoid shell escaping issues on Windows
		const promptFile = join(tmpdir(), `ralphy-opencode-${Date.now()}.txt`);
		writeFileSync(promptFile, prompt, "utf8");
		// Message must come BEFORE -f flag, and use simple message without special characters
		args.push("Execute task from attached file", "-f", promptFile);

		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await execCommand(this.cliCommand, args, workDir, {
				OPENCODE_PERMISSION: '{"*":"allow"}',
			});
		} finally {
			// Clean up temp file
			try { unlinkSync(promptFile); } catch { /* ignore */ }
		}
		const { stdout, stderr, exitCode } = result;
		const output = stdout + stderr;

		// Check for errors
		const error = checkForErrors(output);
		if (error) {
			return {
				success: false,
				response: "",
				inputTokens: 0,
				outputTokens: 0,
				error,
			};
		}

		// Parse OpenCode JSON format
		const { response, inputTokens, outputTokens, cost } = this.parseOutput(output);

		// Consider success if we got valid output (step_finish found) even if exitCode is non-zero
		// OpenCode may return SIGTERM (143) if killed but still produced valid output
		const hasValidOutput = inputTokens > 0 || outputTokens > 0 || response !== "Task completed";
		return {
			success: exitCode === 0 || hasValidOutput,
			response,
			inputTokens,
			outputTokens,
			cost,
		};
	}

	private parseOutput(output: string): {
		response: string;
		inputTokens: number;
		outputTokens: number;
		cost?: string;
	} {
		const lines = output.split("\n").filter(Boolean);
		let response = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let cost: string | undefined;

		// Find step_finish for token counts
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === "step_finish") {
					inputTokens = parsed.part?.tokens?.input || 0;
					outputTokens = parsed.part?.tokens?.output || 0;
					if (parsed.part?.cost) {
						cost = String(parsed.part.cost);
					}
				}
			} catch {
				// Ignore non-JSON lines
			}
		}

		// Get text response from text events
		const textParts: string[] = [];
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === "text" && parsed.part?.text) {
					textParts.push(parsed.part.text);
				}
			} catch {
				// Ignore non-JSON lines
			}
		}

		response = textParts.join("") || "Task completed";

		return { response, inputTokens, outputTokens, cost };
	}
}
