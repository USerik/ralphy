import { describe, test, expect } from "bun:test";
import { buildImplementationPrompt } from "../../../execution/prompts/implementation.ts";
import type { DelegationResult } from "../../../engines/composite.ts";

describe("buildImplementationPrompt", () => {
	const mockDelegation: DelegationResult = {
		success: true,
		delegationPrompt: "## Task\nImplement login feature\n\n## Steps\n1. Create form\n2. Add validation",
		context: "Authentication system",
		acceptanceCriteria: ["Form validates email", "Password is hashed"],
	};

	test("should build implementation prompt with delegation", () => {
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test");

		expect(prompt).toContain("Your Assignment");
		expect(prompt).toContain("Implement login feature");
		expect(prompt).toContain("Acceptance Criteria");
		expect(prompt).toContain("Form validates email");
		expect(prompt).toContain("Password is hashed");
	});

	test("should include implementation instructions", () => {
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test");

		expect(prompt).toContain("Implementation Instructions");
		expect(prompt).toContain("Implement all steps");
		expect(prompt).toContain("Follow ALL acceptance criteria");
		expect(prompt).toContain("Write tests");
		expect(prompt).toContain("Stage your changes");
		expect(prompt).toContain("DO NOT commit yet");
	});

	test("should emphasize not committing", () => {
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test");

		expect(prompt).toContain("DO NOT commit");
		expect(prompt).toContain("your supervisor will review first");
	});

	test("should include feedback when provided", () => {
		const feedback = "## Issues\n- Missing error handling\n- Add input validation";
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test", feedback);

		expect(prompt).toContain("Feedback from Review");
		expect(prompt).toContain("Missing error handling");
		expect(prompt).toContain("Add input validation");
		expect(prompt).toContain("address all the issues");
	});

	test("should add feedback-specific instructions when feedback exists", () => {
		const feedback = "Fix the bugs";
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test", feedback);

		expect(prompt).toContain("Ensure all feedback items from the review are addressed");
		expect(prompt).toContain("Make sure to address ALL feedback");
	});

	test("should not include feedback section when no feedback", () => {
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test");

		expect(prompt).not.toContain("Feedback from Review");
		expect(prompt).not.toContain("address all the issues");
	});

	test("should mention project rules in instructions", () => {
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test");

		// Project rules section is optional (depends on config file)
		// But instructions should mention following rules
		expect(prompt).toContain("follow project rules");
	});

	test("should include important notes", () => {
		const prompt = buildImplementationPrompt(mockDelegation, "/tmp/test");

		expect(prompt).toContain("Important Notes");
		expect(prompt).toContain("Don't over-engineer");
		expect(prompt).toContain("keep it simple");
	});
});
