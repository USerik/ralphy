import type { CompositeEngine, DelegationResult, ReviewResult } from "../engines/composite.ts";
import type { AIResult } from "../engines/types.ts";
import type { Task, TaskSource } from "../tasks/types.ts";
import { createTaskBranch, returnToBaseBranch } from "../git/branch.ts";
import { createPullRequest } from "../git/pr.ts";
import { logTaskProgress } from "../config/writer.ts";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../ui/logger.ts";
import { ProgressSpinner } from "../ui/spinner.ts";
import { notifyTaskComplete, notifyTaskFailed } from "../ui/notify.ts";
import { buildDelegationPrompt } from "./prompts/delegation.ts";
import { buildImplementationPrompt } from "./prompts/implementation.ts";
import { buildReviewPrompt } from "./prompts/review.ts";
import { isRetryableError, withRetry } from "./retry.ts";
import { execCommand } from "../engines/base.ts";

export interface SupervisorExecutionOptions {
	compositeEngine: CompositeEngine;
	taskSource: TaskSource;
	workDir: string;
	skipTests: boolean;
	skipLint: boolean;
	dryRun: boolean;
	maxIterations: number;
	maxRetries: number;
	retryDelay: number;
	branchPerTask: boolean;
	baseBranch: string;
	createPr: boolean;
	draftPr: boolean;
	autoCommit: boolean;
}

export interface SupervisorExecutionResult {
	tasksCompleted: number;
	tasksFailed: number;
	tasksWithWarnings: number;
	totalInputTokens: number;
	totalOutputTokens: number;
}

export interface SupervisorTaskResult {
	success: boolean;
	approved: boolean;
	score: number;
	cycles: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	error?: string;
}

/**
 * Format feedback for worker from review result
 */
function formatFeedbackForWorker(review: ReviewResult): string {
	const parts: string[] = [];

	parts.push(`## Review Feedback (Score: ${review.score.toFixed(2)})`);

	if (review.issues.length > 0) {
		parts.push("\n### Issues to Address:");
		for (const issue of review.issues) {
			const location = issue.location ? ` (${issue.location})` : "";
			parts.push(`- **[${issue.severity}]** ${issue.category}: ${issue.description}${location}`);
		}
	}

	if (review.suggestions.length > 0) {
		parts.push("\n### Suggestions:");
		for (const suggestion of review.suggestions) {
			parts.push(`- ${suggestion}`);
		}
	}

	parts.push("\nPlease fix all issues and implement the suggestions.");

	return parts.join("\n");
}

/**
 * Commit changes with descriptive message
 */
async function commitChanges(
	task: Task,
	review: ReviewResult,
	workDir: string
): Promise<void> {
	try {
		// Stage all changes
		await execCommand("git", ["add", "."], workDir);

		// Create commit message
		const message = `${task.title}

Review score: ${review.score.toFixed(2)}
${review.approved ? "Approved" : "Completed with warnings"}

${review.feedback}

Co-Authored-By: Ralphy Supervisor <ralphy@ralphy.dev>`;

		// Commit
		await execCommand("git", ["commit", "-m", message], workDir);
		logDebug("Changes committed");
	} catch (error) {
		logError(`Failed to commit: ${error}`);
		throw error;
	}
}

/**
 * Run a single task through supervisor/worker cycles
 */
async function runSupervisorTask(
	task: Task,
	compositeEngine: CompositeEngine,
	options: SupervisorExecutionOptions
): Promise<SupervisorTaskResult> {
	const { workDir, maxRetries, retryDelay, autoCommit } = options;
	const maxCycles = compositeEngine.getOptions().maxReviewCycles;
	const approveThreshold = compositeEngine.getOptions().approveThreshold;

	const supervisor = compositeEngine.getSupervisor();
	const worker = compositeEngine.getWorker();

	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	// Step 1: Supervisor delegates the task
	const spinner = new ProgressSpinner(task.title);
	spinner.updateStep("Delegating");

	const delegationPrompt = buildDelegationPrompt(task.body || task.title, workDir);

	let delegation: DelegationResult;
	try {
		delegation = await withRetry(
			async () => {
				const result = await compositeEngine.delegate(delegationPrompt, workDir);
				if (!result.success) {
					throw new Error(result.error || "Delegation failed");
				}
				return result;
			},
			{
				maxRetries,
				retryDelay,
				onRetry: (attempt) => {
					spinner.updateStep(`Delegating (retry ${attempt})`);
				},
			}
		);

		// Track delegation tokens (we called supervisor.execute indirectly)
		// Note: tokens are tracked inside CompositeEngine.delegate()
		logDebug(`Delegation successful: ${delegation.acceptanceCriteria.length} acceptance criteria`);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		spinner.error(errorMsg);
		return {
			success: false,
			approved: false,
			score: 0,
			cycles: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			error: errorMsg,
		};
	}

	// Step 2: Review cycles
	let lastFeedback: string | undefined;
	let finalReview: ReviewResult | null = null;
	let finalApproved = false;

	for (let cycle = 1; cycle <= maxCycles; cycle++) {
		spinner.updateStep(`Implementing (cycle ${cycle}/${maxCycles})`);

		// Worker implements
		const implPrompt = buildImplementationPrompt(delegation, workDir, lastFeedback);
		let implResult: AIResult;

		try {
			implResult = await withRetry(
				async () => {
					const result = await worker.execute(implPrompt, workDir);
					if (!result.success && result.error && isRetryableError(result.error)) {
						throw new Error(result.error);
					}
					return result;
				},
				{
					maxRetries,
					retryDelay,
					onRetry: (attempt) => {
						spinner.updateStep(`Implementing (cycle ${cycle}/${maxCycles}, retry ${attempt})`);
					},
				}
			);

			totalInputTokens += implResult.inputTokens;
			totalOutputTokens += implResult.outputTokens;

			if (!implResult.success) {
				spinner.error(implResult.error || "Implementation failed");
				return {
					success: false,
					approved: false,
					score: 0,
					cycles: cycle,
					totalInputTokens,
					totalOutputTokens,
					error: implResult.error || "Implementation failed",
				};
			}

			logDebug(`Implementation cycle ${cycle} completed`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			spinner.error(errorMsg);
			return {
				success: false,
				approved: false,
				score: 0,
				cycles: cycle,
				totalInputTokens,
				totalOutputTokens,
				error: errorMsg,
			};
		}

		// Supervisor reviews
		spinner.updateStep(`Reviewing (cycle ${cycle}/${maxCycles})`);

		const reviewPrompt = await buildReviewPrompt(
			task.body || task.title,
			delegation,
			implResult,
			workDir,
			cycle
		);

		let reviewResult: ReviewResult;
		try {
			reviewResult = await withRetry(
				async () => {
					const result = await compositeEngine.review(
						reviewPrompt,
						delegation,
						implResult,
						workDir,
						cycle
					);
					if (!result.success) {
						throw new Error(result.error || "Review failed");
					}
					return result;
				},
				{
					maxRetries,
					retryDelay,
					onRetry: (attempt) => {
						spinner.updateStep(`Reviewing (cycle ${cycle}/${maxCycles}, retry ${attempt})`);
					},
				}
			);

			// Note: tokens tracked inside CompositeEngine.review()
			logDebug(`Review cycle ${cycle} completed: score ${reviewResult.score.toFixed(2)}, approved: ${reviewResult.approved}`);
			finalReview = reviewResult;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			spinner.error(errorMsg);
			return {
				success: false,
				approved: false,
				score: 0,
				cycles: cycle,
				totalInputTokens,
				totalOutputTokens,
				error: errorMsg,
			};
		}

		// Check if approved
		if (reviewResult.approved && reviewResult.score >= approveThreshold) {
			finalApproved = true;
			spinner.success(`Approved (score: ${reviewResult.score.toFixed(2)})`);
			logInfo(`Task approved after ${cycle} cycle(s)`);
			break;
		}

		// Check if more cycles available
		if (cycle < maxCycles) {
			logWarn(`Not approved (score: ${reviewResult.score.toFixed(2)}), starting cycle ${cycle + 1}`);
			lastFeedback = formatFeedbackForWorker(reviewResult);
		} else {
			// Max cycles reached
			logWarn(
				`Max review cycles (${maxCycles}) reached. Score: ${reviewResult.score.toFixed(2)}, approved: ${reviewResult.approved}`
			);
			spinner.success(`Completed with warnings (score: ${reviewResult.score.toFixed(2)})`);
		}
	}

	// Step 3: Commit if autoCommit is enabled
	if (autoCommit && finalReview) {
		try {
			await commitChanges(task, finalReview, workDir);
		} catch (error) {
			logWarn(`Commit failed, but task is complete: ${error}`);
		}
	}

	return {
		success: true,
		approved: finalApproved,
		score: finalReview?.score || 0,
		cycles: finalReview ? maxCycles : 0,
		totalInputTokens,
		totalOutputTokens,
	};
}

/**
 * Run supervisor mode execution
 */
export async function runSupervisor(
	options: SupervisorExecutionOptions
): Promise<SupervisorExecutionResult> {
	const {
		compositeEngine,
		taskSource,
		workDir,
		dryRun,
		maxIterations,
		branchPerTask,
		baseBranch,
		createPr,
		draftPr,
	} = options;

	const result: SupervisorExecutionResult = {
		tasksCompleted: 0,
		tasksFailed: 0,
		tasksWithWarnings: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
	};

	let iteration = 0;

	while (true) {
		// Check iteration limit
		if (maxIterations > 0 && iteration >= maxIterations) {
			logInfo(`Reached max iterations (${maxIterations})`);
			break;
		}

		// Get next task
		const task = await taskSource.getNextTask();
		if (!task) {
			logSuccess("All tasks completed!");
			break;
		}

		iteration++;
		const remaining = await taskSource.countRemaining();
		logInfo(`Task ${iteration}: ${task.title} (${remaining} remaining)`);

		// Create branch if needed
		let branch: string | null = null;
		if (branchPerTask && baseBranch) {
			try {
				branch = await createTaskBranch(task.title, baseBranch, workDir);
				logDebug(`Created branch: ${branch}`);
			} catch (error) {
				logError(`Failed to create branch: ${error}`);
			}
		}

		// Execute task
		if (dryRun) {
			logInfo("(dry run) Skipped");
			// Mark task complete even in dry-run to avoid infinite loop
			await taskSource.markComplete(task.id);
		} else {
			const taskResult = await runSupervisorTask(task, compositeEngine, options);

			result.totalInputTokens += taskResult.totalInputTokens;
			result.totalOutputTokens += taskResult.totalOutputTokens;

			if (taskResult.success) {
				// Mark task complete
				await taskSource.markComplete(task.id);

				if (taskResult.approved) {
					logTaskProgress(task.title, "completed", workDir);
					result.tasksCompleted++;
					notifyTaskComplete(task.title);
				} else {
					logTaskProgress(task.title, "completed-with-warnings", workDir);
					result.tasksWithWarnings++;
					notifyTaskComplete(task.title);
				}

				// Create PR if needed
				if (createPr && branch && baseBranch) {
					const prBody = `Automated PR created by Ralphy

**Supervisor**: ${compositeEngine.getSupervisor().name}
**Worker**: ${compositeEngine.getWorker().name}
**Review Score**: ${taskResult.score.toFixed(2)}
**Review Cycles**: ${taskResult.cycles}
**Status**: ${taskResult.approved ? "Approved" : "Completed with warnings"}`;

					const prUrl = await createPullRequest(
						branch,
						baseBranch,
						task.title,
						prBody,
						draftPr,
						workDir
					);

					if (prUrl) {
						logSuccess(`PR created: ${prUrl}`);
					}
				}
			} else {
				logTaskProgress(task.title, "failed", workDir);
				result.tasksFailed++;
				notifyTaskFailed(task.title, taskResult.error || "Unknown error");
			}
		}

		// Return to base branch if we created one
		if (branchPerTask && baseBranch) {
			await returnToBaseBranch(baseBranch, workDir);
		}
	}

	return result;
}
