import type { DelegationResult } from "../../engines/composite.ts";
import type { AIResult } from "../../engines/types.ts";
import { execCommand } from "../../engines/base.ts";

/**
 * Get git diff for review
 */
async function getGitDiff(workDir: string): Promise<string> {
	try {
		const result = await execCommand("git", ["diff", "HEAD"], workDir);
		if (result.exitCode === 0 && result.stdout.trim()) {
			return result.stdout;
		}

		// If no diff from HEAD, check staged changes
		const stagedResult = await execCommand("git", ["diff", "--cached"], workDir);
		if (stagedResult.exitCode === 0 && stagedResult.stdout.trim()) {
			return stagedResult.stdout;
		}

		return "No changes detected";
	} catch (error) {
		return `Error getting diff: ${error}`;
	}
}

/**
 * Build review prompt for supervisor
 */
export async function buildReviewPrompt(
	originalTask: string,
	delegation: DelegationResult,
	implementation: AIResult,
	workDir: string,
	cycle: number
): Promise<string> {
	const parts: string[] = [];

	// Original task
	parts.push(`## Original Task\n${originalTask}`);

	// Acceptance criteria
	if (delegation.acceptanceCriteria.length > 0) {
		parts.push(
			`## Acceptance Criteria\n${delegation.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
		);
	}

	// Get git diff
	const diff = await getGitDiff(workDir);
	parts.push(`## Changes Made\n\`\`\`diff\n${diff}\n\`\`\``);

	// Implementation response
	parts.push(`## Developer's Summary\n${implementation.response}`);

	// Note about review cycle
	if (cycle > 1) {
		parts.push(`## Review Cycle\nThis is review cycle ${cycle}.`);
	}

	// Review instructions
	parts.push(`## Your Review Task

You are a senior software engineer reviewing a junior developer's implementation.

**Review the git diff and working directory carefully**, then evaluate:

1. **Acceptance Criteria**: Are ALL criteria met?
2. **Code Quality**: Is the code clean, maintainable, and well-structured?
3. **Bugs**: Are there any bugs or logic errors?
4. **Tests**: Are appropriate tests written and do they verify the requirements?
5. **Security**: Are there any security concerns (XSS, SQL injection, etc.)?
6. **Standards**: Does it follow project conventions and best practices?

You can access files in the working directory to review implementation details.`);

	// Scoring guidelines
	parts.push(`## Scoring Guidelines

Rate the implementation from 0.0 to 1.0:
- **1.0**: Perfect - all criteria met, excellent quality, no issues
- **0.9**: Excellent - minor cosmetic issues only
- **0.8**: Good - meets requirements with small improvements needed
- **0.7**: Acceptable - works but has quality concerns
- **0.6**: Needs work - missing criteria or significant issues
- **0.0-0.5**: Poor - critical issues, major rework needed`);

	// Required output format
	parts.push(`## Required Output Format

You MUST respond with ONLY a JSON object in the following format (no extra text):

\`\`\`json
{
  "approved": true,
  "score": 0.95,
  "summary": "Brief summary of the review",
  "issues": [
    {
      "severity": "major",
      "category": "functionality",
      "description": "Specific issue description",
      "location": "file.ts:123"
    }
  ],
  "suggestions": [
    "Specific suggestion for improvement"
  ],
  "positives": [
    "What was done well"
  ]
}
\`\`\`

**Fields:**
- \`approved\`: true if ready to merge, false if needs more work
- \`score\`: 0.0 to 1.0 rating
- \`summary\`: Brief overall assessment
- \`issues\`: Array of specific problems (can be empty)
  - \`severity\`: "critical" | "major" | "minor"
  - \`category\`: "functionality" | "quality" | "standards" | "tests" | "security"
  - \`description\`: What the issue is
  - \`location\`: Where it is (optional)
- \`suggestions\`: Array of improvement recommendations (can be empty)
- \`positives\`: Array of things done well (can be empty)

IMPORTANT: Return ONLY the JSON object. No additional commentary.`);

	return parts.join("\n\n");
}

/**
 * Parse review response (extract JSON from markdown or raw)
 */
export function parseReviewResponse(response: string): {
	approved?: boolean;
	score?: number;
	summary?: string;
	issues?: Array<{
		severity: "critical" | "major" | "minor";
		category: "functionality" | "quality" | "standards" | "tests" | "security";
		description: string;
		location?: string;
	}>;
	suggestions?: string[];
	positives?: string[];
} {
	// Try to extract JSON from markdown code block
	const codeBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlockMatch) {
		return JSON.parse(codeBlockMatch[1].trim());
	}

	// Try to find JSON object directly
	const jsonMatch = response.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		return JSON.parse(jsonMatch[0]);
	}

	throw new Error("No valid JSON found in review response");
}
