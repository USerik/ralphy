import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	BaseAIEngine,
	checkForErrors,
	detectStepFromOutput,
	execCommand,
	execCommandStreaming,
	execCommandWithShellPipe,
	parseStreamJsonResult,
} from "./base.ts";
import type { AIResult, EngineOptions, ProgressCallback } from "./types.ts";

/**
 * Claude Code AI Engine
 */
export class ClaudeEngine extends BaseAIEngine {
	name = "Claude Code";
	cliCommand = "claude";

	async execute(prompt: string, workDir: string, options?: EngineOptions): Promise<AIResult> {
		const args = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}

		let result: { stdout: string; stderr: string; exitCode: number };

		// For supervisor mode with disableTools, use shell pipe for large prompts
		if (options?.disableTools) {
			args.push("--tools=");
			args.push("--disable-slash-commands");
			args.push("--system-prompt", "You are a JSON-only response bot. Output ONLY valid JSON. No text, no markdown, no code blocks. Start with { and end with }.");
			// Use shell pipe (type file | command) for reliable stdin on Windows
			result = await execCommandWithShellPipe(prompt, this.cliCommand, args, workDir);
		} else {
			args.push("-p", prompt);
			result = await execCommand(this.cliCommand, args, workDir);
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

		// Parse result
		const { response, inputTokens, outputTokens } = parseStreamJsonResult(output);

		return {
			success: exitCode === 0,
			response,
			inputTokens,
			outputTokens,
		};
	}

	async executeStreaming(
		prompt: string,
		workDir: string,
		onProgress: ProgressCallback,
		options?: EngineOptions,
	): Promise<AIResult> {
		const args = ["--dangerously-skip-permissions", "--verbose", "--output-format", "stream-json"];
		if (options?.modelOverride) {
			args.push("--model", options.modelOverride);
		}
		// Disable tools for supervisor mode (delegation/review) to get JSON response
		// Use '--tools=' (combined arg) for Windows shell compatibility
		if (options?.disableTools) {
			args.push("--tools=");
			args.push("--disable-slash-commands");
			// Override system prompt to enforce JSON-only output
			args.push("--system-prompt", "You are a JSON-only response bot. You MUST output ONLY valid JSON. No text, no greetings, no explanations. Start with { and end with }. The user message contains instructions on what JSON structure to output.");
		}
		args.push("-p", prompt);

		const outputLines: string[] = [];

		const { exitCode } = await execCommandStreaming(this.cliCommand, args, workDir, (line) => {
			outputLines.push(line);

			// Detect and report step changes
			const step = detectStepFromOutput(line);
			if (step) {
				onProgress(step);
			}
		});

		const output = outputLines.join("\n");

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

		// Parse result
		const { response, inputTokens, outputTokens } = parseStreamJsonResult(output);

		return {
			success: exitCode === 0,
			response,
			inputTokens,
			outputTokens,
		};
	}
}
