import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROGRESS_FILE, RALPHY_DIR } from "../config/loader.ts";
import { logTaskProgress } from "../config/writer.ts";
import { execCommand } from "../engines/base.ts";
import type { CompositeEngine, DelegationResult, ReviewResult } from "../engines/composite.ts";
import type { AIResult } from "../engines/types.ts";
import { getCurrentBranch, returnToBaseBranch } from "../git/branch.ts";
import {
	abortMerge,
	deleteLocalBranch,
	mergeAgentBranch,
} from "../git/merge.ts";
import { cleanupAgentWorktree, createAgentWorktree, getWorktreeBase } from "../git/worktree.ts";
import type { Task, TaskSource } from "../tasks/types.ts";
import { YamlTaskSource } from "../tasks/yaml.ts";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "../ui/logger.ts";
import { notifyTaskComplete, notifyTaskFailed } from "../ui/notify.ts";
import { ProgressSpinner } from "../ui/spinner.ts";
import { resolveConflictsWithAI } from "./conflict-resolution.ts";
import { buildDelegationPrompt } from "./prompts/delegation.ts";
import { buildImplementationPrompt } from "./prompts/implementation.ts";
import { buildReviewPrompt } from "./prompts/review.ts";
import { isRetryableError, withRetry } from "./retry.ts";
import type { SupervisorExecutionOptions, SupervisorExecutionResult, SupervisorTaskResult } from "./supervisor.ts";

/**
 * Extended options for parallel supervisor mode
 */
export interface ParallelSupervisorOptions extends SupervisorExecutionOptions {
	maxParallel: number;
	prdSource: string;
	prdFile: string;
	prdIsFolder?: boolean;
	skipMerge?: boolean;
	modelOverride?: string;
	browserEnabled?: "auto" | "true" | "false";
	activeSettings?: string[];
}

/**
 * Result from running supervisor in a worktree
 */
interface SupervisorWorktreeResult {
	task: Task;
	worktreeDir: string;
	branchName: string;
	taskResult: SupervisorTaskResult | null;
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
async function commitChanges(task: Task, review: ReviewResult, workDir: string): Promise<void> {
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
 * Run a single supervisor task in a worktree
 */
async function runSupervisorTaskInWorktree(
	task: Task,
	compositeEngine: CompositeEngine,
	workDir: string,
	maxRetries: number,
	retryDelay: number,
	autoCommit: boolean,
): Promise<SupervisorTaskResult> {
	const maxCycles = compositeEngine.getOptions().maxReviewCycles;
	const approveThreshold = compositeEngine.getOptions().approveThreshold;

	const worker = compositeEngine.getWorker();

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let supervisorInputTokens = 0;
	let supervisorOutputTokens = 0;
	let workerInputTokens = 0;
	let workerOutputTokens = 0;

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
			},
		);

		// Track delegation tokens
		totalInputTokens += delegation.inputTokens;
		totalOutputTokens += delegation.outputTokens;
		supervisorInputTokens += delegation.inputTokens;
		supervisorOutputTokens += delegation.outputTokens;
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
			supervisorInputTokens: 0,
			supervisorOutputTokens: 0,
			workerInputTokens: 0,
			workerOutputTokens: 0,
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
				},
			);

			totalInputTokens += implResult.inputTokens;
			totalOutputTokens += implResult.outputTokens;
			workerInputTokens += implResult.inputTokens;
			workerOutputTokens += implResult.outputTokens;

			if (!implResult.success) {
				spinner.error(implResult.error || "Implementation failed");
				return {
					success: false,
					approved: false,
					score: 0,
					cycles: cycle,
					totalInputTokens,
					totalOutputTokens,
					supervisorInputTokens,
					supervisorOutputTokens,
					workerInputTokens,
					workerOutputTokens,
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
				supervisorInputTokens,
				supervisorOutputTokens,
				workerInputTokens,
				workerOutputTokens,
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
			cycle,
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
						cycle,
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
				},
			);

			// Track review tokens
			totalInputTokens += reviewResult.inputTokens;
			totalOutputTokens += reviewResult.outputTokens;
			supervisorInputTokens += reviewResult.inputTokens;
			supervisorOutputTokens += reviewResult.outputTokens;
			logDebug(
				`Review cycle ${cycle} completed: score ${reviewResult.score.toFixed(2)}, approved: ${reviewResult.approved}`,
			);
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
				supervisorInputTokens,
				supervisorOutputTokens,
				workerInputTokens,
				workerOutputTokens,
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
			logWarn(
				`Not approved (score: ${reviewResult.score.toFixed(2)}), starting cycle ${cycle + 1}`,
			);
			lastFeedback = formatFeedbackForWorker(reviewResult);
		} else {
			// Max cycles reached
			logWarn(
				`Max review cycles (${maxCycles}) reached. Score: ${reviewResult.score.toFixed(2)}, approved: ${reviewResult.approved}`,
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
		supervisorInputTokens,
		supervisorOutputTokens,
		workerInputTokens,
		workerOutputTokens,
	};
}

/**
 * Run a single supervisor-worker pair in a worktree
 */
async function runSupervisorInWorktree(
	compositeEngine: CompositeEngine,
	task: Task,
	agentNum: number,
	baseBranch: string,
	worktreeBase: string,
	originalDir: string,
	prdSource: string,
	prdFile: string,
	prdIsFolder: boolean,
	maxRetries: number,
	retryDelay: number,
	autoCommit: boolean,
): Promise<SupervisorWorktreeResult> {
	let worktreeDir = "";
	let branchName = "";

	try {
		// Create worktree
		const worktree = await createAgentWorktree(
			task.title,
			agentNum,
			baseBranch,
			worktreeBase,
			originalDir,
		);
		worktreeDir = worktree.worktreeDir;
		branchName = worktree.branchName;

		logDebug(`Supervisor ${agentNum}: Created worktree at ${worktreeDir}`);

		// Copy PRD file or folder to worktree
		if (prdSource === "markdown" || prdSource === "yaml") {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				copyFileSync(srcPath, destPath);
			}
		} else if (prdSource === "markdown-folder" && prdIsFolder) {
			const srcPath = join(originalDir, prdFile);
			const destPath = join(worktreeDir, prdFile);
			if (existsSync(srcPath)) {
				cpSync(srcPath, destPath, { recursive: true });
			}
		}

		// Ensure .ralphy/ exists in worktree
		const ralphyDir = join(worktreeDir, RALPHY_DIR);
		if (!existsSync(ralphyDir)) {
			mkdirSync(ralphyDir, { recursive: true });
		}

		// Execute supervisor task in worktree
		const taskResult = await runSupervisorTaskInWorktree(
			task,
			compositeEngine,
			worktreeDir,
			maxRetries,
			retryDelay,
			autoCommit,
		);

		return { task, worktreeDir, branchName, taskResult };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { task, worktreeDir, branchName, taskResult: null, error: errorMsg };
	}
}

/**
 * Merge completed supervisor branches back to the base branch
 */
async function mergeCompletedSupervisorBranches(
	branches: string[],
	targetBranch: string,
	compositeEngine: CompositeEngine,
	workDir: string,
	modelOverride?: string,
): Promise<void> {
	if (branches.length === 0) {
		return;
	}

	logInfo(`\nMerge phase: merging ${branches.length} branch(es) into ${targetBranch}`);

	const merged: string[] = [];
	const failed: string[] = [];

	// Use supervisor engine for conflict resolution (senior AI is better suited)
	const supervisorEngine = compositeEngine.getSupervisor();

	for (const branch of branches) {
		logInfo(`Merging ${branch}...`);

		const mergeResult = await mergeAgentBranch(branch, targetBranch, workDir);

		if (mergeResult.success) {
			logSuccess(`Merged ${branch}`);
			merged.push(branch);
		} else if (mergeResult.hasConflicts && mergeResult.conflictedFiles) {
			// Try AI-assisted conflict resolution using supervisor engine
			logWarn(`Merge conflict in ${branch}, attempting AI resolution...`);

			const resolved = await resolveConflictsWithAI(
				supervisorEngine,
				mergeResult.conflictedFiles,
				branch,
				workDir,
				modelOverride,
			);

			if (resolved) {
				logSuccess(`Resolved conflicts and merged ${branch}`);
				merged.push(branch);
			} else {
				logError(`Failed to resolve conflicts for ${branch}`);
				await abortMerge(workDir);
				failed.push(branch);
			}
		} else {
			logError(`Failed to merge ${branch}: ${mergeResult.error || "Unknown error"}`);
			failed.push(branch);
		}
	}

	// Delete successfully merged branches
	for (const branch of merged) {
		const deleted = await deleteLocalBranch(branch, workDir, true);
		if (deleted) {
			logDebug(`Deleted merged branch: ${branch}`);
		}
	}

	// Summary
	if (merged.length > 0) {
		logSuccess(`Successfully merged ${merged.length} branch(es)`);
	}
	if (failed.length > 0) {
		logWarn(`Failed to merge ${failed.length} branch(es): ${failed.join(", ")}`);
		logInfo("These branches have been preserved for manual review.");
	}
}

/**
 * Run parallel supervisor mode execution
 */
export async function runParallelSupervisor(
	options: ParallelSupervisorOptions,
): Promise<SupervisorExecutionResult> {
	const {
		compositeEngine,
		taskSource,
		workDir,
		dryRun,
		maxIterations,
		maxRetries,
		retryDelay,
		autoCommit,
		maxParallel,
		prdSource,
		prdFile,
		prdIsFolder = false,
		skipMerge,
		modelOverride,
		baseBranch: optionsBaseBranch,
	} = options;

	const result: SupervisorExecutionResult = {
		tasksCompleted: 0,
		tasksFailed: 0,
		tasksWithWarnings: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		supervisorInputTokens: 0,
		supervisorOutputTokens: 0,
		workerInputTokens: 0,
		workerOutputTokens: 0,
	};

	// Get worktree base directory
	const worktreeBase = getWorktreeBase(workDir);
	logDebug(`Worktree base: ${worktreeBase}`);

	// Save starting branch to restore after merge phase
	const startingBranch = await getCurrentBranch(workDir);

	// Save original base branch for merge phase
	const baseBranch = optionsBaseBranch || startingBranch;

	// Track completed branches for merge phase
	const completedBranches: string[] = [];

	// Global agent counter to ensure unique numbering across batches
	let globalAgentNum = 0;

	// Process tasks in batches
	let iteration = 0;

	while (true) {
		// Check iteration limit
		if (maxIterations > 0 && iteration >= maxIterations) {
			logInfo(`Reached max iterations (${maxIterations})`);
			break;
		}

		// Get tasks for this batch
		let tasks: Task[] = [];

		// For YAML sources, try to get tasks from the same parallel group
		if (taskSource instanceof YamlTaskSource) {
			const nextTask = await taskSource.getNextTask();
			if (!nextTask) break;

			const group = await taskSource.getParallelGroup(nextTask.title);
			if (group > 0) {
				tasks = await taskSource.getTasksInGroup(group);
			} else {
				tasks = [nextTask];
			}
		} else {
			// For other sources, get all remaining tasks
			tasks = await taskSource.getAllTasks();
		}

		if (tasks.length === 0) {
			logSuccess("All tasks completed!");
			break;
		}

		// Limit to maxParallel
		const batch = tasks.slice(0, maxParallel);
		iteration++;

		logInfo(`Batch ${iteration}: ${batch.length} supervisor-worker pair(s) in parallel`);

		if (dryRun) {
			logInfo("(dry run) Skipping batch");
			// Mark tasks complete in dry-run to avoid infinite loop
			for (const task of batch) {
				await taskSource.markComplete(task.id);
			}
			continue;
		}

		// Run supervisor-worker pairs in parallel
		const promises = batch.map((task) => {
			globalAgentNum++;
			return runSupervisorInWorktree(
				compositeEngine,
				task,
				globalAgentNum,
				baseBranch,
				worktreeBase,
				workDir,
				prdSource,
				prdFile,
				prdIsFolder,
				maxRetries,
				retryDelay,
				autoCommit,
			);
		});

		const results = await Promise.all(promises);

		// Process results
		for (const agentResult of results) {
			const { task, worktreeDir, branchName, taskResult, error } = agentResult;

			if (error) {
				logError(`Task "${task.title}" failed: ${error}`);
				logTaskProgress(task.title, "failed", workDir);
				result.tasksFailed++;
				notifyTaskFailed(task.title, error);
			} else if (taskResult?.success) {
				// Aggregate tokens
				result.totalInputTokens += taskResult.totalInputTokens;
				result.totalOutputTokens += taskResult.totalOutputTokens;
				result.supervisorInputTokens += taskResult.supervisorInputTokens;
				result.supervisorOutputTokens += taskResult.supervisorOutputTokens;
				result.workerInputTokens += taskResult.workerInputTokens;
				result.workerOutputTokens += taskResult.workerOutputTokens;

				await taskSource.markComplete(task.id);

				if (taskResult.approved) {
					logSuccess(`Task "${task.title}" completed (approved)`);
					logTaskProgress(task.title, "completed", workDir);
					result.tasksCompleted++;
					notifyTaskComplete(task.title);
				} else {
					logWarn(`Task "${task.title}" completed with warnings`);
					logTaskProgress(task.title, "completed-with-warnings", workDir);
					result.tasksWithWarnings++;
					notifyTaskComplete(task.title);
				}

				// Track successful branch for merge phase
				if (branchName) {
					completedBranches.push(branchName);
				}
			} else {
				const errMsg = taskResult?.error || "Unknown error";
				logError(`Task "${task.title}" failed: ${errMsg}`);
				logTaskProgress(task.title, "failed", workDir);
				result.tasksFailed++;
				notifyTaskFailed(task.title, errMsg);
			}

			// Cleanup worktree
			if (worktreeDir) {
				const cleanup = await cleanupAgentWorktree(worktreeDir, branchName, workDir);
				if (cleanup.leftInPlace) {
					logInfo(`Worktree left in place (uncommitted changes): ${worktreeDir}`);
				}
			}
		}
	}

	// Merge phase: merge completed branches back to base branch
	if (!skipMerge && !dryRun && completedBranches.length > 0) {
		await mergeCompletedSupervisorBranches(
			completedBranches,
			baseBranch,
			compositeEngine,
			workDir,
			modelOverride,
		);

		// Restore starting branch if we're not already on it
		const currentBranch = await getCurrentBranch(workDir);
		if (currentBranch !== startingBranch) {
			logDebug(`Restoring starting branch: ${startingBranch}`);
			await returnToBaseBranch(startingBranch, workDir);
		}
	}

	return result;
}
