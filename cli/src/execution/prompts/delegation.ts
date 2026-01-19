import { loadProjectContext, loadRules, loadBoundaries } from "../../config/loader.ts";

/**
 * Build delegation prompt for supervisor
 */
export function buildDelegationPrompt(task: string, workDir: string): string {
	const parts: string[] = [];

	// Project context
	const context = loadProjectContext(workDir);
	if (context) {
		parts.push(`## Project Context\n${context}`);
	}

	// Project rules
	const rules = loadRules(workDir);
	if (rules.length > 0) {
		parts.push(`## Project Rules\n${rules.map((r) => `- ${r}`).join("\n")}`);
	}

	// Boundaries
	const boundaries = loadBoundaries(workDir);
	if (boundaries.length > 0) {
		parts.push(`## Boundaries (Never Touch)\n${boundaries.map((b) => `- ${b}`).join("\n")}`);
	}

	// Task to delegate
	parts.push(`## Task to Delegate\n${task}`);

	// Senior role instructions
	parts.push(`## Your Role

You are a senior software engineer delegating this task to a junior developer. Your job is to:
1. Break down the task into clear, actionable steps
2. Provide context and background information
3. Define acceptance criteria
4. Give technical guidance on the best approach
5. Warn about potential pitfalls
6. Specify testing requirements

Be specific and thorough. The junior developer will implement exactly what you describe.`);

	// Required output format
	parts.push(`## Required Output Format

You MUST respond with ONLY a JSON object in the following format (no extra text):

\`\`\`json
{
  "taskBreakdown": [
    "Step 1: Brief description",
    "Step 2: Brief description",
    "Step 3: Brief description"
  ],
  "context": "Background information the developer needs to know",
  "acceptanceCriteria": [
    "Criterion 1: What must be true when done",
    "Criterion 2: What must be true when done"
  ],
  "technicalGuidance": "Specific technical advice on how to approach this (patterns, libraries, etc.)",
  "potentialPitfalls": [
    "Pitfall 1: What to watch out for",
    "Pitfall 2: What to watch out for"
  ],
  "testingRequirements": "What tests should be written and what they should verify"
}
\`\`\`

IMPORTANT: Return ONLY the JSON object. No additional commentary.`);

	return parts.join("\n\n");
}

/**
 * Parse delegation response (extract JSON from markdown or raw)
 */
export function parseDelegationResponse(response: string): {
	taskBreakdown?: string[];
	context?: string;
	acceptanceCriteria?: string[];
	technicalGuidance?: string;
	potentialPitfalls?: string[];
	testingRequirements?: string;
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

	throw new Error("No valid JSON found in delegation response");
}
