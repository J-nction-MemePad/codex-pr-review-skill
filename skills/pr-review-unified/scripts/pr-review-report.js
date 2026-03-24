#!/usr/bin/env node

"use strict";

const path = require("path");
const { parseArgs, runRuleReview, writeOutput } = require("./pr-review/core");

function main() {
  const args = parseArgs(process.argv);
  const result = runRuleReview({
    args,
    rootDir: path.resolve(args["repo-root"] || process.env.PR_REVIEW_REPO_ROOT || process.cwd()),
  });
  writeOutput(args.output, result.markdown);
  console.error(result.summary);
  process.exit(result.blockers > 0 ? 1 : 0);
}

main();
