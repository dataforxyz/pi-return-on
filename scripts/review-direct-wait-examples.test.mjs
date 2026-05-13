#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/review-direct-wait-examples.mjs");

async function writeJsonl(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function example(id, dedupeKey, classification, commandPreview = "sleep 12") {
  return {
    version: 1,
    exampleId: id,
    dedupeKey,
    classification,
    reviewStatus: "unreviewed",
    source: { sessionFile: `/tmp/${id}.jsonl`, cwd: "/tmp/project", timestamp: 1 },
    bash: { commandPreview },
    detection: { primaryKind: "long sleep", matches: [{ kind: "long sleep", detail: "sleep 12", backgrounded: false, severity: "direct_wait" }] },
    nearbyReturnOn: { toolCalls: [], registrations: [] },
  };
}

test("review tool summarizes deduped corpus and samples unreviewed examples", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-review-"));
  const corpus = path.join(dir, "examples.jsonl");
  const reviews = path.join(dir, "reviews.jsonl");
  await writeJsonl(corpus, [
    example("dwe_1", "same", "missed_candidate", "sleep 12"),
    example("dwe_2", "same", "missed_candidate", "sleep 12"),
    example("dwe_3", "other", "backgrounded_with_return_on", "npm test & echo $! > .return-on/test.pid"),
  ]);

  const { stdout } = await execFileAsync(process.execPath, [script, "--corpus", corpus, "--reviews", reviews, "--sample", "5", "--json"], { cwd: path.resolve(".") });
  const summary = JSON.parse(stdout);
  assert.equal(summary.rawExamples, 3);
  assert.equal(summary.dedupedExamples, 2);
  assert.equal(summary.unreviewedDeduped, 2);
  assert.equal(summary.sample.length, 2);
});

test("review tool appends sidecar marks without changing corpus", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-return-on-review-"));
  const corpus = path.join(dir, "examples.jsonl");
  const reviews = path.join(dir, "reviews.jsonl");
  await writeJsonl(corpus, [example("dwe_1", "same", "missed_candidate")]);
  const before = await fs.readFile(corpus, "utf8");

  await execFileAsync(process.execPath, [script, "--corpus", corpus, "--reviews", reviews, "--mark", "dwe_1", "--verdict", "true_positive", "--notes", "real wait", "--reviewer", "test"], { cwd: path.resolve(".") });
  assert.equal(await fs.readFile(corpus, "utf8"), before);
  const [review] = (await fs.readFile(reviews, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(review.exampleId, "dwe_1");
  assert.equal(review.verdict, "true_positive");
  assert.equal(review.notes, "real wait");

  const { stdout } = await execFileAsync(process.execPath, [script, "--corpus", corpus, "--reviews", reviews, "--json"], { cwd: path.resolve(".") });
  const summary = JSON.parse(stdout);
  assert.equal(summary.reviewedDeduped, 1);
  assert.equal(summary.reviewVerdicts.true_positive, 1);
});
