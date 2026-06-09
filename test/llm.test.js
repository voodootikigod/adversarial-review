import assert from "node:assert/strict";
import test from "node:test";
import { cleanJsonResponse } from "../src/llm.js";

test("cleanJsonResponse extracts plain valid JSON", () => {
  const input = '{"verdict": "approve", "summary": "good"}';
  const expected = '{"verdict": "approve", "summary": "good"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse extracts JSON from markdown blocks", () => {
  const input = '```json\n{"verdict": "approve"}\n```';
  const expected = '{"verdict": "approve"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse extracts JSON from markdown blocks with surrounding prose", () => {
  const input = 'Here is the result:\n```json\n{"verdict": "needs-attention"}\n```\nHope this helps!';
  const expected = '{"verdict": "needs-attention"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse extracts JSON even if prose has curly braces", () => {
  const input = 'The review of the {auth} changes is here:\n```json\n{"verdict": "approve"}\n```';
  const expected = '{"verdict": "approve"}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse handles JSON that contains code blocks as string properties", () => {
  const input = '{\n  "code": "```javascript\\nconsole.log(1);\\n```"\n}';
  const expected = '{\n  "code": "```javascript\\nconsole.log(1);\\n```"\n}';
  assert.equal(cleanJsonResponse(input), expected);
});

test("cleanJsonResponse returns trimmed input if no JSON structures are identified", () => {
  const input = "  plain text response  ";
  const expected = "plain text response";
  assert.equal(cleanJsonResponse(input), expected);
});
