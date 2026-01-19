import { describe, test, expect, mock } from "bun:test";
import { CompositeEngine } from "../../engines/composite.ts";
import type { AIEngine, AIResult } from "../../engines/types.ts";

// Mock AI Engine
class MockEngine implements AIEngine {
	name: string;
	cliCommand: string;
	private mockResponse: string;

	constructor(name: string, mockResponse: string = "Task completed") {
		this.name = name;
		this.cliCommand = "mock-cli";
		this.mockResponse = mockResponse;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async execute(prompt: string, workDir: string): Promise<AIResult> {
		return {
			success: true,
			response: this.mockResponse,
			inputTokens: 100,
			outputTokens: 200,
		};
	}
}

describe("CompositeEngine", () => {
	test("should create composite engine with correct name", () => {
		const supervisor = new MockEngine("Claude");
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		expect(composite.name).toBe("Claude→OpenCode");
	});

	test("should check availability of both engines", async () => {
		const supervisor = new MockEngine("Claude");
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		const available = await composite.isAvailable();
		expect(available).toBe(true);
	});

	test("should throw error when execute() is called directly", async () => {
		const supervisor = new MockEngine("Claude");
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		await expect(composite.execute("test", "/tmp")).rejects.toThrow(
			"CompositeEngine.execute() should not be called directly"
		);
	});

	test("should delegate task and parse JSON response", async () => {
		const delegationResponse = `
\`\`\`json
{
  "taskBreakdown": ["Step 1", "Step 2"],
  "context": "Test context",
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
  "technicalGuidance": "Use TypeScript",
  "potentialPitfalls": ["Pitfall 1"],
  "testingRequirements": "Write unit tests"
}
\`\`\`
`;
		const supervisor = new MockEngine("Claude", delegationResponse);
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		const result = await composite.delegate("Add login feature", "/tmp");

		expect(result.success).toBe(true);
		expect(result.acceptanceCriteria).toEqual(["Criterion 1", "Criterion 2"]);
		expect(result.context).toBe("Test context");
		expect(result.delegationPrompt).toContain("Step 1");
		expect(result.delegationPrompt).toContain("Step 2");
	});

	test("should handle delegation failure", async () => {
		const supervisor = new MockEngine("Claude", "Invalid response");
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		const result = await composite.delegate("Add login feature", "/tmp");

		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("should review implementation and parse JSON response", async () => {
		const reviewResponse = `
\`\`\`json
{
  "approved": true,
  "score": 0.95,
  "summary": "Excellent implementation",
  "issues": [],
  "suggestions": ["Consider adding more tests"],
  "positives": ["Clean code", "Good structure"]
}
\`\`\`
`;
		const supervisor = new MockEngine("Claude", reviewResponse);
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		const delegation = {
			success: true,
			delegationPrompt: "Test delegation",
			context: "Test context",
			acceptanceCriteria: ["Test criterion"],
		};

		const implementation: AIResult = {
			success: true,
			response: "Implementation completed",
			inputTokens: 100,
			outputTokens: 200,
		};

		const result = await composite.review(
			"Original task",
			delegation,
			implementation,
			"/tmp",
			1
		);

		expect(result.success).toBe(true);
		expect(result.approved).toBe(true);
		expect(result.score).toBe(0.95);
		expect(result.feedback).toContain("Excellent implementation");
		expect(result.suggestions).toEqual(["Consider adding more tests"]);
	});

	test("should handle review with issues", async () => {
		const reviewResponse = `
\`\`\`json
{
  "approved": false,
  "score": 0.65,
  "summary": "Needs improvement",
  "issues": [
    {
      "severity": "major",
      "category": "functionality",
      "description": "Missing error handling",
      "location": "src/auth.ts:42"
    }
  ],
  "suggestions": ["Add try-catch blocks"],
  "positives": []
}
\`\`\`
`;
		const supervisor = new MockEngine("Claude", reviewResponse);
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		const delegation = {
			success: true,
			delegationPrompt: "Test delegation",
			context: "Test context",
			acceptanceCriteria: ["Test criterion"],
		};

		const implementation: AIResult = {
			success: true,
			response: "Implementation completed",
			inputTokens: 100,
			outputTokens: 200,
		};

		const result = await composite.review(
			"Original task",
			delegation,
			implementation,
			"/tmp",
			1
		);

		expect(result.success).toBe(true);
		expect(result.approved).toBe(false);
		expect(result.score).toBe(0.65);
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].severity).toBe("major");
		expect(result.feedback).toContain("Missing error handling");
	});

	test("should get options correctly", () => {
		const supervisor = new MockEngine("Claude");
		const worker = new MockEngine("OpenCode");
		const options = {
			maxReviewCycles: 5,
			approveThreshold: 0.9,
		};
		const composite = new CompositeEngine(supervisor, worker, options);

		const retrievedOptions = composite.getOptions();
		expect(retrievedOptions.maxReviewCycles).toBe(5);
		expect(retrievedOptions.approveThreshold).toBe(0.9);
	});

	test("should get supervisor and worker engines", () => {
		const supervisor = new MockEngine("Claude");
		const worker = new MockEngine("OpenCode");
		const composite = new CompositeEngine(supervisor, worker, {
			maxReviewCycles: 3,
			approveThreshold: 0.8,
		});

		expect(composite.getSupervisor().name).toBe("Claude");
		expect(composite.getWorker().name).toBe("OpenCode");
	});
});
