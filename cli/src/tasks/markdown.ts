import { readFileSync, writeFileSync } from "node:fs";
import type { Task, TaskSource } from "./types.ts";

/**
 * Markdown task source - reads tasks from markdown files with checkbox format
 * Format: "- [ ] Task description" (incomplete) or "- [x] Task description" (complete)
 */
export class MarkdownTaskSource implements TaskSource {
	type = "markdown" as const;
	private filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async getAllTasks(): Promise<Task[]> {
		const content = readFileSync(this.filePath, "utf-8");
		const tasks: Task[] = [];
		// Normalize line endings (CRLF -> LF) for Windows compatibility
		const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Match incomplete tasks
			const incompleteMatch = line.match(/^- \[ \] (.+)$/);
			if (incompleteMatch) {
				tasks.push({
					id: String(i + 1), // Line number as ID
					title: incompleteMatch[1].trim(),
					completed: false,
				});
			}
		}

		return tasks;
	}

	async getNextTask(): Promise<Task | null> {
		const tasks = await this.getAllTasks();
		return tasks[0] || null;
	}

	async markComplete(id: string): Promise<void> {
		const content = readFileSync(this.filePath, "utf-8");
		// Detect original line ending style
		const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
		// Normalize for processing
		const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		const lineNumber = Number.parseInt(id, 10) - 1;

		if (lineNumber >= 0 && lineNumber < lines.length) {
			// Replace "- [ ]" with "- [x]"
			lines[lineNumber] = lines[lineNumber].replace(/^- \[ \] /, "- [x] ");
			// Write back with original line ending style
			writeFileSync(this.filePath, lines.join(lineEnding), "utf-8");
		}
	}

	async countRemaining(): Promise<number> {
		const content = readFileSync(this.filePath, "utf-8");
		// Normalize line endings for consistent matching
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const matches = normalized.match(/^- \[ \] /gm);
		return matches?.length || 0;
	}

	async countCompleted(): Promise<number> {
		const content = readFileSync(this.filePath, "utf-8");
		// Normalize line endings for consistent matching
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const matches = normalized.match(/^- \[x\] /gim);
		return matches?.length || 0;
	}
}
