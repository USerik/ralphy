import { execCommand } from "../../engines/base.ts";
import type { DelegationResult } from "../../engines/composite.ts";
import type { AIResult } from "../../engines/types.ts";

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
	cycle: number,
): Promise<string> {
	const parts: string[] = [];

	// CRITICAL: JSON requirement at the very start (same pattern as delegation.ts)
	parts.push(`CRITICAL INSTRUCTION: You MUST respond with ONLY a valid JSON object. No text before or after. No markdown code blocks. Just raw JSON starting with { and ending with }.

DO NOT greet the user. DO NOT ask questions. DO NOT use any tools. DO NOT add any commentary. Just output the JSON.`);

	// Required output format - put early so it's not forgotten
	parts.push(`Required JSON format:
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
  "suggestions": ["Specific suggestion for improvement"],
  "positives": ["What was done well"]
}

Fields:
- approved: true if ready to merge, false if needs more work
- score: 0.0 to 1.0 rating
- summary: Brief overall assessment
- issues: Array of problems (can be empty), severity: "critical"|"major"|"minor", category: "functionality"|"quality"|"standards"|"tests"|"security"
- suggestions: Array of improvements (can be empty)
- positives: Array of things done well (can be empty)`);

	// Scoring guidelines (brief)
	parts.push(`Scoring Guidelines:
- 1.0: Perfect - all criteria met, excellent quality
- 0.8-0.9: Good - meets requirements with minor issues
- 0.6-0.7: Acceptable - works but has quality concerns
- 0.0-0.5: Poor - critical issues, major rework needed`);

	// Original task
	parts.push(`## Original Task\n${originalTask}`);

	// Acceptance criteria
	if (delegation.acceptanceCriteria.length > 0) {
		parts.push(
			`## Acceptance Criteria\n${delegation.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
		);
	}

	// Get git diff
	const diff = await getGitDiff(workDir);
	parts.push(`## Changes Made\n\`\`\`diff\n${diff}\n\`\`\``);

	// Implementation response
	parts.push(`## Developer's Summary\n${implementation.response}`);

	// Note about review cycle
	if (cycle > 1) {
		parts.push(`## Review Cycle\nThis is review cycle ${cycle}. Focus on whether previous issues were fixed.`);
	}

	// Reminder at the end
	parts.push(`REMINDER: Output ONLY the JSON object. Start your response with { character. No markdown code blocks, no explanations, no greetings.`);

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
