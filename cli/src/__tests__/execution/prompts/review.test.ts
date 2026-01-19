import { describe, test, expect } from "bun:test";
import { parseReviewResponse } from "../../../execution/prompts/review.ts";

describe("parseReviewResponse", () => {
	test("should parse review JSON from markdown code block", () => {
		const response = `
\`\`\`json
{
  "approved": true,
  "score": 0.95,
  "summary": "Excellent work",
  "issues": [],
  "suggestions": ["Add more tests"],
  "positives": ["Clean code"]
}
\`\`\`
`;

		const parsed = parseReviewResponse(response);

		expect(parsed.approved).toBe(true);
		expect(parsed.score).toBe(0.95);
		expect(parsed.summary).toBe("Excellent work");
		expect(parsed.issues).toEqual([]);
		expect(parsed.suggestions).toEqual(["Add more tests"]);
		expect(parsed.positives).toEqual(["Clean code"]);
	});

	test("should parse review with issues", () => {
		const response = `
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
    },
    {
      "severity": "minor",
      "category": "quality",
      "description": "Variable naming inconsistent"
    }
  ],
  "suggestions": ["Add try-catch", "Rename variables"],
  "positives": ["Good structure"]
}
\`\`\`
`;

		const parsed = parseReviewResponse(response);

		expect(parsed.approved).toBe(false);
		expect(parsed.score).toBe(0.65);
		expect(parsed.issues).toHaveLength(2);
		expect(parsed.issues![0].severity).toBe("major");
		expect(parsed.issues![0].category).toBe("functionality");
		expect(parsed.issues![0].description).toBe("Missing error handling");
		expect(parsed.issues![0].location).toBe("src/auth.ts:42");
		expect(parsed.issues![1].location).toBeUndefined();
	});

	test("should parse raw JSON without code block", () => {
		const response = `{
  "approved": true,
  "score": 0.88,
  "summary": "Good",
  "issues": [],
  "suggestions": [],
  "positives": []
}`;

		const parsed = parseReviewResponse(response);

		expect(parsed.approved).toBe(true);
		expect(parsed.score).toBe(0.88);
		expect(parsed.summary).toBe("Good");
	});

	test("should throw error for invalid response", () => {
		const response = "This is not JSON";

		expect(() => parseReviewResponse(response)).toThrow(
			"No valid JSON found in review response"
		);
	});

	test("should handle all severity levels", () => {
		const response = `
\`\`\`json
{
  "approved": false,
  "score": 0.5,
  "summary": "Multiple issues",
  "issues": [
    {"severity": "critical", "category": "security", "description": "SQL injection"},
    {"severity": "major", "category": "functionality", "description": "Logic error"},
    {"severity": "minor", "category": "quality", "description": "Style issue"}
  ],
  "suggestions": [],
  "positives": []
}
\`\`\`
`;

		const parsed = parseReviewResponse(response);

		expect(parsed.issues).toHaveLength(3);
		expect(parsed.issues![0].severity).toBe("critical");
		expect(parsed.issues![1].severity).toBe("major");
		expect(parsed.issues![2].severity).toBe("minor");
	});

	test("should handle all issue categories", () => {
		const response = `
\`\`\`json
{
  "approved": false,
  "score": 0.6,
  "summary": "Various issues",
  "issues": [
    {"severity": "major", "category": "functionality", "description": "Bug"},
    {"severity": "major", "category": "quality", "description": "Poor naming"},
    {"severity": "major", "category": "standards", "description": "Not following conventions"},
    {"severity": "major", "category": "tests", "description": "Missing tests"},
    {"severity": "critical", "category": "security", "description": "Vulnerability"}
  ],
  "suggestions": [],
  "positives": []
}
\`\`\`
`;

		const parsed = parseReviewResponse(response);

		expect(parsed.issues).toHaveLength(5);
		expect(parsed.issues!.map((i) => i.category)).toEqual([
			"functionality",
			"quality",
			"standards",
			"tests",
			"security",
		]);
	});

	test("should handle empty arrays", () => {
		const response = `
\`\`\`json
{
  "approved": true,
  "score": 1.0,
  "summary": "Perfect",
  "issues": [],
  "suggestions": [],
  "positives": []
}
\`\`\`
`;

		const parsed = parseReviewResponse(response);

		expect(parsed.issues).toEqual([]);
		expect(parsed.suggestions).toEqual([]);
		expect(parsed.positives).toEqual([]);
	});
});
