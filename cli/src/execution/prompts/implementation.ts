import type { DelegationResult } from "../../engines/composite.ts";
import { loadProjectContext, loadRules, loadBoundaries } from "../../config/loader.ts";

/**
 * Build implementation prompt for worker
 */
export function buildImplementationPrompt(
	delegation: DelegationResult,
	workDir: string,
	feedback?: string
): string {
	const parts: string[] = [];

	// Project context
	const context = loadProjectContext(workDir);
	if (context) {
		parts.push(`## Project Context\n${context}`);
	}

	// Project rules
	const rules = loadRules(workDir);
	if (rules.length > 0) {
		parts.push(`## Project Rules (MUST follow)\n${rules.map((r) => `- ${r}`).join("\n")}`);
	}

	// Boundaries
	const boundaries = loadBoundaries(workDir);
	if (boundaries.length > 0) {
		parts.push(`## Boundaries (NEVER modify these)\n${boundaries.map((b) => `- ${b}`).join("\n")}`);
	}

	// Assignment
	parts.push(`## Your Assignment\n${delegation.delegationPrompt}`);

	// Acceptance criteria
	if (delegation.acceptanceCriteria.length > 0) {
		parts.push(
			`## Acceptance Criteria (ALL must be met)\n${delegation.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
		);
	}

	// Feedback from previous attempt (if this is a retry)
	if (feedback) {
		parts.push(`## Feedback from Review\n${feedback}\n\nPlease address all the issues mentioned above.`);
	}

	// Implementation instructions
	const instructions = [
		"1. Implement all steps from the assignment above",
		"2. Follow ALL acceptance criteria",
		"3. Write tests as specified in the testing requirements",
		"4. Stage your changes (git add)",
		"5. DO NOT commit yet - your work will be reviewed first",
		"6. Keep code clean, well-documented, and follow project rules",
	];

	if (feedback) {
		instructions.push("7. Ensure all feedback items from the review are addressed");
	}

	parts.push(`## Implementation Instructions\n${instructions.join("\n")}`);

	// Final note
	parts.push(
		`## Important Notes

- Stage your changes but DO NOT commit - your supervisor will review first
- Focus on meeting all acceptance criteria
- Write clean, maintainable code
- Don't over-engineer - keep it simple and focused
${feedback ? "- Make sure to address ALL feedback from the review" : ""}`
	);

	return parts.join("\n\n");
}
