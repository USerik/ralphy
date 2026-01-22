import { loadProjectContext, loadRules, loadBoundaries } from "../../config/loader.ts";

/**
 * Build delegation prompt for supervisor
 */
export function buildDelegationPrompt(task: string, workDir: string): string {
	const parts: string[] = [];

	// CRITICAL: JSON requirement at the very start
	parts.push(`CRITICAL INSTRUCTION: You MUST respond with ONLY a valid JSON object. No text before or after. No markdown code blocks. Just raw JSON starting with { and ending with }.

DO NOT greet the user. DO NOT ask questions. DO NOT use any tools. Just output the JSON.`);

	// Required output format - put early so it's not forgotten
	parts.push(`Required JSON format:
{
  "taskBreakdown": ["Step 1: description", "Step 2: description"],
  "context": "Background information",
  "acceptanceCriteria": ["What must be true when done"],
  "technicalGuidance": "Technical advice",
  "potentialPitfalls": ["What to watch out for"],
  "testingRequirements": "What tests to write"
}`);

	// Task to delegate
	parts.push(`Task to analyze and delegate: ${task}`);

	// Project context (brief)
	const context = loadProjectContext(workDir);
	if (context) {
		// Limit context to avoid overwhelming the prompt
		const briefContext = context.substring(0, 2000);
		parts.push(`Project context (for your reference only, do not include in response):\n${briefContext}`);
	}

	// Project rules
	const rules = loadRules(workDir);
	if (rules.length > 0) {
		parts.push(`Project rules to consider:\n${rules.slice(0, 5).map((r) => `- ${r}`).join("\n")}`);
	}

	// Boundaries
	const boundaries = loadBoundaries(workDir);
	if (boundaries.length > 0) {
		parts.push(`Files to never touch:\n${boundaries.slice(0, 5).map((b) => `- ${b}`).join("\n")}`);
	}

	// Reminder at the end
	parts.push(`REMINDER: Output ONLY the JSON object. Start your response with { character.`);

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
