import { existsSync } from "node:fs";
import type { AIEngineName } from "../../engines/types.ts";
import { createEngine, isEngineAvailable } from "../../engines/index.ts";
import { CompositeEngine } from "../../engines/composite.ts";
import { createTaskSource } from "../../tasks/index.ts";
import { runSequential } from "../../execution/sequential.ts";
import { runParallel } from "../../execution/parallel.ts";
import { isBrowserAvailable } from "../../execution/browser.ts";
import { runSupervisor } from "../../execution/supervisor.ts";
import { getDefaultBaseBranch } from "../../git/branch.ts";
import { logError, logInfo, logSuccess, setVerbose, formatDuration, formatTokens } from "../../ui/logger.ts";
import { notifyAllComplete } from "../../ui/notify.ts";
import { buildActiveSettings } from "../../ui/settings.ts";
import type { RuntimeOptions } from "../../config/types.ts";

/**
 * Run the PRD loop (multiple tasks from file/GitHub)
 */
export async function runLoop(options: RuntimeOptions): Promise<void> {
	const workDir = process.cwd();
	const startTime = Date.now();

	// Set verbose mode
	setVerbose(options.verbose);

	// Validate PRD source
	if (options.prdSource === "markdown" || options.prdSource === "yaml") {
		if (!existsSync(options.prdFile)) {
			logError(`${options.prdFile} not found in current directory`);
			logInfo(`Create a ${options.prdFile} file with tasks`);
			process.exit(1);
		}
	}

	if (options.prdSource === "github" && !options.githubRepo) {
		logError("GitHub repository not specified. Use --github owner/repo");
		process.exit(1);
	}

	// Detect supervisor mode
	const isSupervisorMode = !!(options.supervisorEngine && options.workerEngine);

	// Check engine availability
	let engine;
	let compositeEngine;

	if (isSupervisorMode) {
		// Create and check both supervisor and worker engines
		const supervisor = createEngine(options.supervisorEngine!);
		const worker = createEngine(options.workerEngine!);

		const supervisorAvailable = await supervisor.isAvailable();
		const workerAvailable = await worker.isAvailable();

		if (!supervisorAvailable) {
			logError(`Supervisor ${supervisor.name} CLI not found. Make sure '${supervisor.cliCommand}' is in your PATH.`);
			process.exit(1);
		}

		if (!workerAvailable) {
			logError(`Worker ${worker.name} CLI not found. Make sure '${worker.cliCommand}' is in your PATH.`);
			process.exit(1);
		}

		// Create composite engine
		compositeEngine = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: options.maxReviewCycles,
			approveThreshold: options.approveThreshold,
		});

		logInfo(`Supervisor Mode: ${supervisor.name} → ${worker.name}`);
	} else {
		engine = createEngine(options.aiEngine);
		const available = await isEngineAvailable(options.aiEngine);

		if (!available) {
			logError(`${engine.name} CLI not found. Make sure '${engine.cliCommand}' is in your PATH.`);
			process.exit(1);
		}
	}

	// Create task source
	const taskSource = createTaskSource({
		type: options.prdSource,
		filePath: options.prdFile,
		repo: options.githubRepo,
		label: options.githubLabel,
	});

	// Check if there are tasks
	const remaining = await taskSource.countRemaining();
	if (remaining === 0) {
		logSuccess("No tasks remaining. All done!");
		return;
	}

	// Get base branch if needed
	let baseBranch = options.baseBranch;
	if ((options.branchPerTask || options.parallel || options.createPr) && !baseBranch) {
		baseBranch = await getDefaultBaseBranch(workDir);
	}

	if (!isSupervisorMode) {
		logInfo(`Starting Ralphy with ${engine!.name}`);
	}
	logInfo(`Tasks remaining: ${remaining}`);
	if (isSupervisorMode) {
		logInfo(`Mode: Supervisor (max ${options.maxReviewCycles} review cycles, threshold ${options.approveThreshold})`);
	} else if (options.parallel) {
		logInfo(`Mode: Parallel (max ${options.maxParallel} agents)`);
	} else {
		logInfo("Mode: Sequential");
	}
	if (isBrowserAvailable(options.browserEnabled)) {
		logInfo("Browser automation enabled (agent-browser)");
	}
	console.log("");

	// Build active settings for display
	const activeSettings = buildActiveSettings(options);

	// Run tasks
	let result;
	if (isSupervisorMode) {
		result = await runSupervisor({
			compositeEngine: compositeEngine!,
			taskSource,
			workDir,
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			dryRun: options.dryRun,
			maxIterations: options.maxIterations,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay,
			branchPerTask: options.branchPerTask,
			baseBranch,
			createPr: options.createPr,
			draftPr: options.draftPr,
			autoCommit: options.autoCommit,
		});
	} else if (options.parallel) {
		result = await runParallel({
			engine: engine!,
			taskSource,
			workDir,
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			dryRun: options.dryRun,
			maxIterations: options.maxIterations,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay,
			branchPerTask: options.branchPerTask,
			baseBranch,
			createPr: options.createPr,
			draftPr: options.draftPr,
			autoCommit: options.autoCommit,
			browserEnabled: options.browserEnabled,
			maxParallel: options.maxParallel,
			prdSource: options.prdSource,
			prdFile: options.prdFile,
			activeSettings,
		});
	} else {
		result = await runSequential({
			engine: engine!,
			taskSource,
			workDir,
			skipTests: options.skipTests,
			skipLint: options.skipLint,
			dryRun: options.dryRun,
			maxIterations: options.maxIterations,
			maxRetries: options.maxRetries,
			retryDelay: options.retryDelay,
			branchPerTask: options.branchPerTask,
			baseBranch,
			createPr: options.createPr,
			draftPr: options.draftPr,
			autoCommit: options.autoCommit,
			browserEnabled: options.browserEnabled,
			activeSettings,
		});
	}

	// Summary
	const duration = Date.now() - startTime;
	console.log("");
	console.log("=".repeat(50));
	logInfo("Summary:");
	console.log(`  Completed: ${result.tasksCompleted}`);
	if (isSupervisorMode && "tasksWithWarnings" in result && result.tasksWithWarnings > 0) {
		console.log(`  Warnings:  ${result.tasksWithWarnings}`);
	}
	console.log(`  Failed:    ${result.tasksFailed}`);
	console.log(`  Duration:  ${formatDuration(duration)}`);
	if (result.totalInputTokens > 0 || result.totalOutputTokens > 0) {
		console.log(`  Tokens:    ${formatTokens(result.totalInputTokens, result.totalOutputTokens)}`);
		if (isSupervisorMode && "supervisorInputTokens" in result) {
			console.log(`    Supervisor: ${formatTokens(result.supervisorInputTokens, result.supervisorOutputTokens)}`);
			console.log(`    Worker:     ${formatTokens(result.workerInputTokens, result.workerOutputTokens)}`);
		}
	}
	console.log("=".repeat(50));

	if (result.tasksCompleted > 0) {
		notifyAllComplete(result.tasksCompleted);
	}

	if (result.tasksFailed > 0) {
		process.exit(1);
	}
}
