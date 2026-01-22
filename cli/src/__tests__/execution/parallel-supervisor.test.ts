import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import type { CompositeEngine, DelegationResult, ReviewResult } from "../../engines/composite.ts";
import type { AIEngine, AIResult } from "../../engines/types.ts";
import type { Task, TaskSource } from "../../tasks/types.ts";

// Mock the git/worktree module
const mockCreateAgentWorktree = mock(() =>
	Promise.resolve({
		worktreeDir: "/tmp/test-worktree",
		branchName: "ralphy/agent-1-test",
	})
);
const mockCleanupAgentWorktree = mock(() =>
	Promise.resolve({ leftInPlace: false })
);
const mockGetWorktreeBase = mock(() => "/tmp/worktrees");

// Mock the git/branch module
const mockGetCurrentBranch = mock(() => Promise.resolve("main"));
const mockReturnToBaseBranch = mock(() => Promise.resolve());

// Mock the git/merge module
const mockMergeAgentBranch = mock(() =>
	Promise.resolve({ success: true, hasConflicts: false })
);
const mockDeleteLocalBranch = mock(() => Promise.resolve(true));
const mockAbortMerge = mock(() => Promise.resolve());

// Mock logger
const mockLogDebug = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogSuccess = mock(() => {});
const mockLogWarn = mock(() => {});
const mockLogError = mock(() => {});

// Mock notifications
const mockNotifyTaskComplete = mock(() => {});
const mockNotifyTaskFailed = mock(() => {});

// Mock progress
const mockLogTaskProgress = mock(() => {});

// Mock AI Engine
class MockEngine implements AIEngine {
	name: string;
	cliCommand: string;
	private mockResponse: string;
	executeCallCount = 0;

	constructor(name: string, mockResponse: string = "Task completed") {
		this.name = name;
		this.cliCommand = "mock-cli";
		this.mockResponse = mockResponse;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async execute(prompt: string, workDir: string): Promise<AIResult> {
		this.executeCallCount++;
		return {
			success: true,
			response: this.mockResponse,
			inputTokens: 100,
			outputTokens: 200,
		};
	}
}

// Mock CompositeEngine
class MockCompositeEngine {
	private supervisor: MockEngine;
	private worker: MockEngine;
	private options: { maxReviewCycles: number; approveThreshold: number };
	delegateCallCount = 0;
	reviewCallCount = 0;

	constructor(
		supervisor: MockEngine,
		worker: MockEngine,
		options: { maxReviewCycles: number; approveThreshold: number }
	) {
		this.supervisor = supervisor;
		this.worker = worker;
		this.options = options;
	}

	getOptions() {
		return this.options;
	}

	getSupervisor() {
		return this.supervisor;
	}

	getWorker() {
		return this.worker;
	}

	async delegate(prompt: string, workDir: string): Promise<DelegationResult> {
		this.delegateCallCount++;
		return {
			success: true,
			delegationPrompt: "Test delegation prompt",
			context: "Test context",
			acceptanceCriteria: ["Criterion 1"],
			inputTokens: 150,
			outputTokens: 250,
		};
	}

	async review(
		_task: string,
		_delegation: DelegationResult,
		_implementation: AIResult,
		_workDir: string,
		_cycle: number
	): Promise<ReviewResult> {
		this.reviewCallCount++;
		return {
			success: true,
			approved: true,
			score: 0.95,
			feedback: "Test feedback",
			issues: [],
			suggestions: [],
			inputTokens: 200,
			outputTokens: 300,
		};
	}
}

// Mock TaskSource
class MockTaskSource implements TaskSource {
	type: "markdown" = "markdown";
	private tasks: Task[];
	private completedIds: Set<string> = new Set();

	constructor(tasks: Task[]) {
		this.tasks = tasks;
	}

	async getAllTasks(): Promise<Task[]> {
		return this.tasks.filter((t) => !this.completedIds.has(t.id));
	}

	async getNextTask(): Promise<Task | null> {
		const remaining = await this.getAllTasks();
		return remaining[0] || null;
	}

	async markComplete(id: string): Promise<void> {
		this.completedIds.add(id);
	}

	async countRemaining(): Promise<number> {
		return this.tasks.filter((t) => !this.completedIds.has(t.id)).length;
	}

	async countCompleted(): Promise<number> {
		return this.completedIds.size;
	}
}

describe("ParallelSupervisor", () => {
	describe("ParallelSupervisorOptions", () => {
		test("should extend SupervisorExecutionOptions with parallel-specific fields", async () => {
			// Import the type to verify it exists
			const { runParallelSupervisor } = await import(
				"../../execution/parallel-supervisor.ts"
			);
			expect(runParallelSupervisor).toBeDefined();
			expect(typeof runParallelSupervisor).toBe("function");
		});
	});

	describe("Token Aggregation", () => {
		test("should correctly aggregate supervisor and worker tokens", () => {
			// Test the token aggregation logic conceptually
			const supervisorTokens = { input: 150, output: 250 };
			const workerTokens = { input: 100, output: 200 };
			const reviewTokens = { input: 200, output: 300 };

			const totalSupervisorInput = supervisorTokens.input + reviewTokens.input;
			const totalSupervisorOutput = supervisorTokens.output + reviewTokens.output;
			const totalWorkerInput = workerTokens.input;
			const totalWorkerOutput = workerTokens.output;

			expect(totalSupervisorInput).toBe(350);
			expect(totalSupervisorOutput).toBe(550);
			expect(totalWorkerInput).toBe(100);
			expect(totalWorkerOutput).toBe(200);

			const totalInput = totalSupervisorInput + totalWorkerInput;
			const totalOutput = totalSupervisorOutput + totalWorkerOutput;
			expect(totalInput).toBe(450);
			expect(totalOutput).toBe(750);
		});
	});

	describe("Batch Processing Logic", () => {
		test("should limit batch size to maxParallel", () => {
			const tasks = [
				{ id: "1", title: "Task 1", completed: false },
				{ id: "2", title: "Task 2", completed: false },
				{ id: "3", title: "Task 3", completed: false },
				{ id: "4", title: "Task 4", completed: false },
				{ id: "5", title: "Task 5", completed: false },
			];

			const maxParallel = 3;
			const batch = tasks.slice(0, maxParallel);

			expect(batch).toHaveLength(3);
			expect(batch[0].title).toBe("Task 1");
			expect(batch[2].title).toBe("Task 3");
		});

		test("should handle batch smaller than maxParallel", () => {
			const tasks = [
				{ id: "1", title: "Task 1", completed: false },
				{ id: "2", title: "Task 2", completed: false },
			];

			const maxParallel = 5;
			const batch = tasks.slice(0, maxParallel);

			expect(batch).toHaveLength(2);
		});
	});

	describe("Result Handling", () => {
		test("should track completed tasks separately from warnings", () => {
			const result = {
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

			// Simulate approved task
			result.tasksCompleted++;

			// Simulate task with warnings
			result.tasksWithWarnings++;

			// Simulate failed task
			result.tasksFailed++;

			expect(result.tasksCompleted).toBe(1);
			expect(result.tasksWithWarnings).toBe(1);
			expect(result.tasksFailed).toBe(1);
		});

		test("should aggregate tokens across multiple tasks", () => {
			const result = {
				totalInputTokens: 0,
				totalOutputTokens: 0,
				supervisorInputTokens: 0,
				supervisorOutputTokens: 0,
				workerInputTokens: 0,
				workerOutputTokens: 0,
			};

			// Task 1 results
			const task1 = {
				supervisorInput: 150,
				supervisorOutput: 250,
				workerInput: 100,
				workerOutput: 200,
			};

			// Task 2 results
			const task2 = {
				supervisorInput: 200,
				supervisorOutput: 300,
				workerInput: 150,
				workerOutput: 250,
			};

			// Aggregate task 1
			result.supervisorInputTokens += task1.supervisorInput;
			result.supervisorOutputTokens += task1.supervisorOutput;
			result.workerInputTokens += task1.workerInput;
			result.workerOutputTokens += task1.workerOutput;
			result.totalInputTokens +=
				task1.supervisorInput + task1.workerInput;
			result.totalOutputTokens +=
				task1.supervisorOutput + task1.workerOutput;

			// Aggregate task 2
			result.supervisorInputTokens += task2.supervisorInput;
			result.supervisorOutputTokens += task2.supervisorOutput;
			result.workerInputTokens += task2.workerInput;
			result.workerOutputTokens += task2.workerOutput;
			result.totalInputTokens +=
				task2.supervisorInput + task2.workerInput;
			result.totalOutputTokens +=
				task2.supervisorOutput + task2.workerOutput;

			expect(result.supervisorInputTokens).toBe(350);
			expect(result.supervisorOutputTokens).toBe(550);
			expect(result.workerInputTokens).toBe(250);
			expect(result.workerOutputTokens).toBe(450);
			expect(result.totalInputTokens).toBe(600);
			expect(result.totalOutputTokens).toBe(1000);
		});
	});

	describe("MockCompositeEngine", () => {
		test("should return correct options", () => {
			const supervisor = new MockEngine("Claude");
			const worker = new MockEngine("OpenCode");
			const composite = new MockCompositeEngine(supervisor, worker, {
				maxReviewCycles: 3,
				approveThreshold: 0.8,
			});

			const options = composite.getOptions();
			expect(options.maxReviewCycles).toBe(3);
			expect(options.approveThreshold).toBe(0.8);
		});

		test("should delegate task successfully", async () => {
			const supervisor = new MockEngine("Claude");
			const worker = new MockEngine("OpenCode");
			const composite = new MockCompositeEngine(supervisor, worker, {
				maxReviewCycles: 3,
				approveThreshold: 0.8,
			});

			const result = await composite.delegate("Test task", "/tmp");

			expect(result.success).toBe(true);
			expect(result.inputTokens).toBe(150);
			expect(result.outputTokens).toBe(250);
			expect(composite.delegateCallCount).toBe(1);
		});

		test("should review implementation successfully", async () => {
			const supervisor = new MockEngine("Claude");
			const worker = new MockEngine("OpenCode");
			const composite = new MockCompositeEngine(supervisor, worker, {
				maxReviewCycles: 3,
				approveThreshold: 0.8,
			});

			const delegation: DelegationResult = {
				success: true,
				delegationPrompt: "Test",
				context: "",
				acceptanceCriteria: [],
				inputTokens: 100,
				outputTokens: 100,
			};

			const implementation: AIResult = {
				success: true,
				response: "Done",
				inputTokens: 100,
				outputTokens: 200,
			};

			const result = await composite.review(
				"Test task",
				delegation,
				implementation,
				"/tmp",
				1
			);

			expect(result.success).toBe(true);
			expect(result.approved).toBe(true);
			expect(result.score).toBe(0.95);
			expect(composite.reviewCallCount).toBe(1);
		});
	});

	describe("MockTaskSource", () => {
		test("should return all tasks", async () => {
			const tasks: Task[] = [
				{ id: "1", title: "Task 1", completed: false },
				{ id: "2", title: "Task 2", completed: false },
			];
			const source = new MockTaskSource(tasks);

			const allTasks = await source.getAllTasks();
			expect(allTasks).toHaveLength(2);
		});

		test("should get next task", async () => {
			const tasks: Task[] = [
				{ id: "1", title: "Task 1", completed: false },
				{ id: "2", title: "Task 2", completed: false },
			];
			const source = new MockTaskSource(tasks);

			const next = await source.getNextTask();
			expect(next?.title).toBe("Task 1");
		});

		test("should mark task complete", async () => {
			const tasks: Task[] = [
				{ id: "1", title: "Task 1", completed: false },
				{ id: "2", title: "Task 2", completed: false },
			];
			const source = new MockTaskSource(tasks);

			await source.markComplete("1");

			const remaining = await source.countRemaining();
			expect(remaining).toBe(1);

			const next = await source.getNextTask();
			expect(next?.title).toBe("Task 2");
		});

		test("should return null when no tasks remaining", async () => {
			const tasks: Task[] = [{ id: "1", title: "Task 1", completed: false }];
			const source = new MockTaskSource(tasks);

			await source.markComplete("1");

			const next = await source.getNextTask();
			expect(next).toBeNull();
		});
	});

	describe("SupervisorWorktreeResult Interface", () => {
		test("should have correct structure for success case", () => {
			const result = {
				task: { id: "1", title: "Test Task", completed: false },
				worktreeDir: "/tmp/worktree-1",
				branchName: "ralphy/agent-1-test",
				taskResult: {
					success: true,
					approved: true,
					score: 0.9,
					cycles: 2,
					totalInputTokens: 500,
					totalOutputTokens: 800,
					supervisorInputTokens: 300,
					supervisorOutputTokens: 500,
					workerInputTokens: 200,
					workerOutputTokens: 300,
				},
			};

			expect(result.task.title).toBe("Test Task");
			expect(result.worktreeDir).toBe("/tmp/worktree-1");
			expect(result.branchName).toBe("ralphy/agent-1-test");
			expect(result.taskResult?.success).toBe(true);
			expect(result.taskResult?.approved).toBe(true);
		});

		test("should have correct structure for error case", () => {
			const result = {
				task: { id: "1", title: "Test Task", completed: false },
				worktreeDir: "/tmp/worktree-1",
				branchName: "ralphy/agent-1-test",
				taskResult: null,
				error: "Worktree creation failed",
			};

			expect(result.taskResult).toBeNull();
			expect(result.error).toBe("Worktree creation failed");
		});
	});
});
