#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const home = os.homedir();
const stateDir = path.join(home, ".local", "state", "pi-return-on");
const defaultCorpus = path.join(stateDir, "direct-wait-examples.jsonl");
const defaultReviews = path.join(stateDir, "direct-wait-example-reviews.jsonl");
const allowedVerdicts = new Set([
  "true_positive",
  "false_positive",
  "safe_candidate",
  "needs_return_on",
  "acceptable",
  "unclear",
]);

const args = process.argv.slice(2);
let corpus = defaultCorpus;
let reviews = defaultReviews;
let sample = 0;
let classification;
let verdict;
let markId;
let notes = "";
let reviewer = process.env.USER || "unknown";
let json = false;
let includeReviewed = false;
let help = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") help = true;
  else if (arg === "--json") json = true;
  else if (arg === "--include-reviewed") includeReviewed = true;
  else if (arg === "--corpus") corpus = path.resolve(args[++i] ?? "");
  else if (arg.startsWith("--corpus=")) corpus = path.resolve(arg.slice("--corpus=".length));
  else if (arg === "--reviews") reviews = path.resolve(args[++i] ?? "");
  else if (arg.startsWith("--reviews=")) reviews = path.resolve(arg.slice("--reviews=".length));
  else if (arg === "--sample") sample = Number(args[++i] ?? "0");
  else if (arg.startsWith("--sample=")) sample = Number(arg.slice("--sample=".length));
  else if (arg === "--classification") classification = args[++i];
  else if (arg.startsWith("--classification=")) classification = arg.slice("--classification=".length);
  else if (arg === "--mark") markId = args[++i];
  else if (arg.startsWith("--mark=")) markId = arg.slice("--mark=".length);
  else if (arg === "--verdict") verdict = args[++i];
  else if (arg.startsWith("--verdict=")) verdict = arg.slice("--verdict=".length);
  else if (arg === "--notes") notes = args[++i] ?? "";
  else if (arg.startsWith("--notes=")) notes = arg.slice("--notes=".length);
  else if (arg === "--reviewer") reviewer = args[++i] ?? reviewer;
  else if (arg.startsWith("--reviewer=")) reviewer = arg.slice("--reviewer=".length);
  else throw new Error(`Unknown option: ${arg}`);
}

if (help) {
  console.log(`Usage: node scripts/review-direct-wait-examples.mjs [options]

Summarize and review the structured direct-wait corpus. Reviews are appended to
a sidecar JSONL file and source sessions are never modified.

Options:
  --corpus <file>          Corpus path (default: ${defaultCorpus})
  --reviews <file>         Review ledger path (default: ${defaultReviews})
  --sample <n>             Show n deduped examples, default 0
  --classification <name>  Filter summary/sample to a classification
  --include-reviewed       Include reviewed examples in samples
  --mark <exampleId>       Append a review for an example
  --verdict <verdict>      One of: ${[...allowedVerdicts].join(", ")}
  --notes <text>           Optional review notes
  --reviewer <name>        Reviewer name for sidecar entry
  --json                   Print JSON summary/sample
  -h, --help               Show this help

Examples:
  npm run review:direct-waits
  npm run review:direct-waits -- --sample 20 --classification missed_candidate
  npm run review:direct-waits -- --mark dwe_abc --verdict false_positive --notes "prose/example"
`);
  process.exit(0);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(file) {
  if (!(await exists(file))) return [];
  const raw = await fs.readFile(file, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore partial/corrupt lines.
    }
  }
  return entries;
}

function countBy(entries, getKey) {
  const result = {};
  for (const entry of entries) {
    const key = getKey(entry) ?? "unknown";
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function latestReviews(reviewEntries) {
  const latest = new Map();
  for (const review of reviewEntries) {
    if (!review?.exampleId) continue;
    latest.set(review.exampleId, review);
  }
  return latest;
}

function dedupeExamples(examples) {
  const seen = new Set();
  const deduped = [];
  for (const example of examples) {
    const key = example.dedupeKey || example.exampleId;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(example);
  }
  return deduped;
}

function compactExample(example, review) {
  return {
    exampleId: example.exampleId,
    dedupeKey: example.dedupeKey,
    classification: example.classification,
    reviewStatus: review?.verdict ?? "unreviewed",
    primaryKind: example.detection?.primaryKind,
    matches: example.detection?.matches?.map((match) => ({ kind: match.kind, detail: match.detail, backgrounded: match.backgrounded, severity: match.severity })),
    commandPreview: example.bash?.commandPreview,
    source: example.source ? { sessionFile: example.source.sessionFile, cwd: example.source.cwd, timestamp: example.source.timestamp } : undefined,
    nearbyReturnOn: {
      toolCalls: example.nearbyReturnOn?.toolCalls?.length ?? 0,
      registrations: example.nearbyReturnOn?.registrations?.length ?? 0,
    },
    review,
  };
}

const examples = await readJsonl(corpus);
if (markId) {
  if (!verdict || !allowedVerdicts.has(verdict)) {
    throw new Error(`--verdict is required with --mark and must be one of: ${[...allowedVerdicts].join(", ")}`);
  }
  const target = examples.find((example) => example.exampleId === markId);
  if (!target) throw new Error(`No example found for ${markId} in ${corpus}`);
  const review = {
    version: 1,
    exampleId: markId,
    dedupeKey: target.dedupeKey,
    verdict,
    notes,
    reviewer,
    reviewedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(reviews), { recursive: true });
  await fs.appendFile(reviews, `${JSON.stringify(review)}\n`, "utf8");
  if (json) console.log(JSON.stringify({ marked: review }, null, 2));
  else console.log(`Marked ${markId} as ${verdict} in ${reviews}`);
  process.exit(0);
}

const reviewEntries = await readJsonl(reviews);
const reviewByExample = latestReviews(reviewEntries);
const filtered = classification ? examples.filter((example) => example.classification === classification) : examples;
const deduped = dedupeExamples(filtered);
const reviewedDeduped = deduped.filter((example) => reviewByExample.has(example.exampleId));
const unreviewedDeduped = deduped.filter((example) => !reviewByExample.has(example.exampleId));
const samplePool = includeReviewed ? deduped : unreviewedDeduped;
const sampleExamples = sample > 0 ? samplePool.slice(0, sample).map((example) => compactExample(example, reviewByExample.get(example.exampleId))) : [];

const summary = {
  corpus,
  reviews,
  rawExamples: examples.length,
  filteredExamples: filtered.length,
  dedupedExamples: deduped.length,
  reviewedDeduped: reviewedDeduped.length,
  unreviewedDeduped: unreviewedDeduped.length,
  classifications: countBy(examples, (example) => example.classification),
  dedupedClassifications: countBy(dedupeExamples(examples), (example) => example.classification),
  reviewVerdicts: countBy(reviewEntries, (review) => review.verdict),
  sample: sampleExamples,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Corpus: ${corpus}`);
  console.log(`Reviews: ${reviews}`);
  console.log(`Raw examples: ${summary.rawExamples}`);
  console.log(`Deduped examples${classification ? ` (${classification})` : ""}: ${summary.dedupedExamples}`);
  console.log(`Reviewed deduped: ${summary.reviewedDeduped}`);
  console.log(`Unreviewed deduped: ${summary.unreviewedDeduped}`);
  console.log(`Classifications: ${JSON.stringify(summary.dedupedClassifications)}`);
  console.log(`Review verdicts: ${JSON.stringify(summary.reviewVerdicts)}`);
  for (const example of sampleExamples) {
    console.log(`\n${example.exampleId} [${example.classification}/${example.primaryKind}] ${example.reviewStatus}`);
    console.log(`  ${example.commandPreview}`);
    console.log(`  source: ${example.source?.sessionFile}`);
  }
}
