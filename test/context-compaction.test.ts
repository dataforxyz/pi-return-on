import assert from "node:assert/strict";
import test from "node:test";
import { compactReturnOnHandlerMessages } from "../src/context-compaction.ts";

test("compacts routine return_on handler receipts while preserving lookup pointers", () => {
	const receipt = {
		role: "custom",
		customType: "return-on-handler",
		content: [
			"return_on handler completed: build watcher (ro_123)",
			"Handler: roh_123",
			"Exit: 0",
			"Output: /tmp/pi-return-on/stdout.log (10000 B)",
			"Errors: none (/tmp/pi-return-on/stderr.log, 0 B)",
			"",
			"Routine success with marker RETURN_ON_OK.",
			`NOISY ${"x".repeat(500)}`,
			`NOISY2 ${"x".repeat(500)}`,
			`NOISY3 ${"x".repeat(500)}`,
		].join("\n"),
	};

	const result = compactReturnOnHandlerMessages([receipt]);
	const compacted = result[0] as { content: string };
	assert.match(compacted.content, /compacted for model context/);
	assert.match(compacted.content, /Handler: roh_123/);
	assert.match(compacted.content, /Output: \/tmp\/pi-return-on\/stdout\.log \(10000 B\)/);
	assert.match(compacted.content, /Errors: none/);
	assert.match(compacted.content, /RETURN_ON_OK/);
	assert.doesNotMatch(compacted.content, /NOISY3/);
	assert.ok(compacted.content.length < receipt.content.length);
});

test("does not recompact already compacted return_on handler receipts", () => {
	const compacted = {
		role: "custom",
		customType: "return-on-handler",
		content: "return_on handler receipt (compacted for model context; routine success).\nHandler: roh_123\nOutput: /tmp/out.log (10 B)",
	};

	assert.deepEqual(compactReturnOnHandlerMessages([compacted]), [compacted]);
});

test("does not compact failed return_on handler receipts", () => {
	const failed = {
		role: "custom",
		customType: "return-on-handler",
		content: "return_on handler failed: build watcher\nHandler: roh_123\nExit: 1\nOutput: /tmp/out.log (10 B)\n\nFailure details stay inline.",
	};

	assert.deepEqual(compactReturnOnHandlerMessages([failed]), [failed]);
});
