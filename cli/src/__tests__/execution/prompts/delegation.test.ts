import { describe, test, expect } from "bun:test";
import { buildDelegationPrompt, parseDelegationResponse } from "../../../execution/prompts/delegation.ts";

describe("buildDelegationPrompt", () => {
	test("should build delegation prompt with task", () => {
		const prompt = buildDelegationPrompt("Add login feature", "/tmp/test");

		expect(prompt).toContain("Task to Delegate");
		expect(prompt).toContain("Add login feature");
		expect(prompt).toContain("Your Role");
		expect(prompt).toContain("senior software engineer");
		expect(prompt).toContain("Required Output Format");
		expect(prompt).toContain("taskBreakdown");
		expect(prompt).toContain("acceptanceCriteria");
	});

	test("should include JSON output format", () => {
		const prompt = buildDelegationPrompt("Add feature", "/tmp/test");

		expect(prompt).toContain("```json");
		expect(prompt).toContain("taskBreakdown");
		expect(prompt).toContain("context");
		expect(prompt).toContain("acceptanceCriteria");
		expect(prompt).toContain("technicalGuidance");
		expect(prompt).toContain("potentialPitfalls");
		expect(prompt).toContain("testingRequirements");
	});

	test("should emphasize JSON-only response", () => {
		const prompt = buildDelegationPrompt("Add feature", "/tmp/test");

		expect(prompt).toContain("ONLY a JSON object");
		expect(prompt).toContain("No additional commentary");
	});
});

describe("parseDelegationResponse", () => {
	test("should parse JSON from markdown code block", () => {
		const response = `
\`\`\`json
{
  "taskBreakdown": ["Step 1", "Step 2"],
  "context": "Test context",
  "acceptanceCriteria": ["Criterion 1"],
  "technicalGuidance": "Use TypeScript",
  "potentialPitfalls": ["Pitfall 1"],
  "testingRequirements": "Write tests"
}
\`\`\`
`;

		const parsed = parseDelegationResponse(response);

		expect(parsed.taskBreakdown).toEqual(["Step 1", "Step 2"]);
		expect(parsed.context).toBe("Test context");
		expect(parsed.acceptanceCriteria).toEqual(["Criterion 1"]);
		expect(parsed.technicalGuidance).toBe("Use TypeScript");
	});

	test("should parse raw JSON without code block", () => {
		const response = `{
  "taskBreakdown": ["Step A"],
  "context": "Direct JSON",
  "acceptanceCriteria": ["Must work"]
}`;

		const parsed = parseDelegationResponse(response);

		expect(parsed.taskBreakdown).toEqual(["Step A"]);
		expect(parsed.context).toBe("Direct JSON");
		expect(parsed.acceptanceCriteria).toEqual(["Must work"]);
	});

	test("should throw error for invalid response", () => {
		const response = "This is not JSON";

		expect(() => parseDelegationResponse(response)).toThrow(
			"No valid JSON found in delegation response"
		);
	});

	test("should handle JSON without 'json' language marker", () => {
		const response = `
\`\`\`
{
  "taskBreakdown": ["Step X"],
  "context": "No language marker"
}
\`\`\`
`;

		const parsed = parseDelegationResponse(response);

		expect(parsed.taskBreakdown).toEqual(["Step X"]);
		expect(parsed.context).toBe("No language marker");
	});
});
