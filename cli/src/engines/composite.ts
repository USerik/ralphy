import type { AIEngine, AIResult } from "./types.ts";
import { logDebug, logError } from "../ui/logger.ts";

/**
 * Delegation result from supervisor
 */
export interface DelegationResult {
	success: boolean;
	delegationPrompt: string;
	context: string;
	acceptanceCriteria: string[];
	error?: string;
}

/**
 * Review issue details
 */
export interface ReviewIssue {
	severity: "critical" | "major" | "minor";
	category: "functionality" | "quality" | "standards" | "tests" | "security";
	description: string;
	location?: string;
}

/**
 * Review result from supervisor
 */
export interface ReviewResult {
	success: boolean;
	approved: boolean;
	score: number;
	feedback: string;
	issues: ReviewIssue[];
	suggestions: string[];
	error?: string;
}

/**
 * Composite engine options
 */
export interface CompositeEngineOptions {
	maxReviewCycles: number;
	approveThreshold: number;
}

/**
 * Parse JSON from markdown code block or raw JSON
 */
function parseJsonFromResponse(response: string): any {
	// Try to extract JSON from markdown code block
	const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlockMatch) {
		try {
			return JSON.parse(codeBlockMatch[1].trim());
		} catch (error) {
			logDebug(`Failed to parse JSON from code block: ${error}`);
		}
	}

	// Try to find JSON object directly in response
	const jsonMatch = response.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			return JSON.parse(jsonMatch[0]);
		} catch (error) {
			logDebug(`Failed to parse JSON from response: ${error}`);
		}
	}

	throw new Error("No valid JSON found in response");
}

/**
 * CompositeEngine combines supervisor and worker engines
 * for delegated task execution with review cycles
 */
export class CompositeEngine implements AIEngine {
	name: string;
	cliCommand: string;

	constructor(
		private supervisor: AIEngine,
		private worker: AIEngine,
		private options: CompositeEngineOptions
	) {
		this.name = `${supervisor.name}→${worker.name}`;
		this.cliCommand = supervisor.cliCommand;
	}

	async isAvailable(): Promise<boolean> {
		const supervisorAvailable = await this.supervisor.isAvailable();
		const workerAvailable = await this.worker.isAvailable();
		return supervisorAvailable && workerAvailable;
	}

	/**
	 * Not used directly - use delegate(), implement(), review() instead
	 */
	async execute(prompt: string, workDir: string): Promise<AIResult> {
		throw new Error(
			"CompositeEngine.execute() should not be called directly. Use delegate(), implement(), review() methods."
		);
	}

	/**
	 * Supervisor delegates a task with structured guidance
	 */
	async delegate(task: string, workDir: string): Promise<DelegationResult> {
		logDebug(`[Supervisor] Delegating task...`);

		try {
			const result = await this.supervisor.execute(task, workDir);

			if (!result.success) {
				return {
					success: false,
					delegationPrompt: "",
					context: "",
					acceptanceCriteria: [],
					error: result.error || "Delegation failed",
				};
			}

			// Parse JSON response
			const parsed = parseJsonFromResponse(result.response);

			// Build delegation prompt from parsed data
			const parts: string[] = [];

			if (parsed.taskBreakdown && Array.isArray(parsed.taskBreakdown)) {
				parts.push("## Task Breakdown");
				parts.push(parsed.taskBreakdown.map((step: string, i: number) => `${i + 1}. ${step}`).join("\n"));
			}

			if (parsed.context) {
				parts.push(`## Context\n${parsed.context}`);
			}

			if (parsed.technicalGuidance) {
				parts.push(`## Technical Guidance\n${parsed.technicalGuidance}`);
			}

			if (parsed.potentialPitfalls && Array.isArray(parsed.potentialPitfalls)) {
				parts.push("## Potential Pitfalls");
				parts.push(parsed.potentialPitfalls.map((p: string) => `- ${p}`).join("\n"));
			}

			if (parsed.testingRequirements) {
				parts.push(`## Testing Requirements\n${parsed.testingRequirements}`);
			}

			const delegationPrompt = parts.join("\n\n");
			const acceptanceCriteria = parsed.acceptanceCriteria || [];

			return {
				success: true,
				delegationPrompt,
				context: parsed.context || "",
				acceptanceCriteria,
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logError(`Failed to parse delegation response: ${errorMsg}`);
			return {
				success: false,
				delegationPrompt: "",
				context: "",
				acceptanceCriteria: [],
				error: errorMsg,
			};
		}
	}

	/**
	 * Worker implements the delegated task
	 */
	async implement(
		delegation: DelegationResult,
		workDir: string,
		feedback?: string
	): Promise<AIResult> {
		logDebug(`[Worker] Implementing task...`);

		// The prompt will be built by the caller (supervisor.ts)
		// This is just a pass-through to the worker engine
		// We should not be calling this directly - it's called from supervisor execution

		throw new Error(
			"CompositeEngine.implement() is not meant to be called directly. Implementation is handled by supervisor execution flow."
		);
	}

	/**
	 * Supervisor reviews the implementation
	 */
	async review(
		originalTask: string,
		delegation: DelegationResult,
		implementation: AIResult,
		workDir: string,
		cycle: number
	): Promise<ReviewResult> {
		logDebug(`[Supervisor] Reviewing implementation (cycle ${cycle})...`);

		try {
			const result = await this.supervisor.execute(originalTask, workDir);

			if (!result.success) {
				return {
					success: false,
					approved: false,
					score: 0,
					feedback: result.error || "Review failed",
					issues: [],
					suggestions: [],
					error: result.error || "Review failed",
				};
			}

			// Parse JSON response
			const parsed = parseJsonFromResponse(result.response);

			// Extract fields with defaults
			const approved = parsed.approved === true;
			const score = typeof parsed.score === "number" ? parsed.score : 0;
			const summary = parsed.summary || "";
			const issues: ReviewIssue[] = Array.isArray(parsed.issues) ? parsed.issues : [];
			const suggestions: string[] = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
			const positives: string[] = Array.isArray(parsed.positives) ? parsed.positives : [];

			// Build feedback text
			const feedbackParts: string[] = [];

			if (summary) {
				feedbackParts.push(`## Summary\n${summary}`);
			}

			if (issues.length > 0) {
				feedbackParts.push("## Issues Found");
				for (const issue of issues) {
					const location = issue.location ? ` (${issue.location})` : "";
					feedbackParts.push(`- [${issue.severity}] ${issue.category}: ${issue.description}${location}`);
				}
			}

			if (suggestions.length > 0) {
				feedbackParts.push("## Suggestions");
				feedbackParts.push(suggestions.map((s) => `- ${s}`).join("\n"));
			}

			if (positives.length > 0) {
				feedbackParts.push("## What Went Well");
				feedbackParts.push(positives.map((p) => `- ${p}`).join("\n"));
			}

			const feedback = feedbackParts.join("\n\n");

			return {
				success: true,
				approved,
				score,
				feedback,
				issues,
				suggestions,
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logError(`Failed to parse review response: ${errorMsg}`);
			return {
				success: false,
				approved: false,
				score: 0,
				feedback: `Review parsing failed: ${errorMsg}`,
				issues: [],
				suggestions: [],
				error: errorMsg,
			};
		}
	}

	/**
	 * Get the options
	 */
	getOptions(): CompositeEngineOptions {
		return this.options;
	}

	/**
	 * Get supervisor engine
	 */
	getSupervisor(): AIEngine {
		return this.supervisor;
	}

	/**
	 * Get worker engine
	 */
	getWorker(): AIEngine {
		return this.worker;
	}
}
