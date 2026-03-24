#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");
const {
  parseArgs,
  resolveRepoRoot,
  readEvent,
  readContext,
  createRuntime,
  writeOutput,
  buildMarkdown,
  normalizeRuleFinding,
} = require("./core");

const SKILL_ROOT = path.resolve(__dirname, "..", "..");
const SHARED_ASSET_ROOT = path.join(SKILL_ROOT, "assets", "pr-review");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stableSlug(value) {
  return (value || "local").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeSeverity(severity) {
  const map = {
    blocker: "Blocker",
    critical: "Blocker",
    major: "Major",
    medium: "Major",
    minor: "Minor",
    low: "Minor",
    question: "Question",
    info: "Question",
    needsinfo: "Question",
    "needs-info": "Question",
  };
  const normalized = String(severity || "").toLowerCase().replace(/[^a-z-]/g, "");
  return map[normalized] || "Question";
}

function severityRank(severity) {
  return {
    Blocker: 0,
    Major: 1,
    Minor: 2,
    Question: 3,
  }[severity] ?? 9;
}

function normalizeAiFinding(finding, reviewer) {
  return {
    reviewer,
    severity: normalizeSeverity(finding.severity),
    title: String(finding.title || "").trim(),
    detail: String(finding.detail || "").trim(),
    evidence: String(finding.evidence || "n/a").trim(),
    file: finding.file ? String(finding.file) : undefined,
    line: Number.isFinite(Number(finding.line)) ? Number(finding.line) : undefined,
    category: String(finding.category || "ai-review"),
    confidence: typeof finding.confidence === "number" ? finding.confidence : 0.6,
  };
}

function resolveCommand(args) {
  return args.command || args.mode || args._[0] || "review";
}

function resolveReviewerProvider(reviewer, config) {
  return (
    config.reviewers?.[reviewer]?.provider ||
    {
      "codex-reviewer": "codex",
      "claude-reviewer": "claude",
      "simplify-reviewer": "claude",
    }[reviewer] ||
    "unknown"
  );
}

function resolvePromptPath(rootDir, config, reviewer) {
  const configured = config.reviewers?.[reviewer]?.promptPath;
  if (configured) {
    const resolved = path.resolve(rootDir, configured);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  const specific = path.join(rootDir, "config/pr-review/prompts", `${reviewer}.md`);
  if (fs.existsSync(specific)) {
    return specific;
  }
  const repoDefault = path.join(rootDir, "config/pr-review/prompts/reviewer-prompt.md");
  if (fs.existsSync(repoDefault)) {
    return repoDefault;
  }
  const sharedSpecific = path.join(SHARED_ASSET_ROOT, "prompts", `${reviewer}.md`);
  if (fs.existsSync(sharedSpecific)) {
    return sharedSpecific;
  }
  return path.join(SHARED_ASSET_ROOT, "prompts", "reviewer-prompt.md");
}

function resolveSchemaPath(rootDir) {
  const repoSchema = path.join(rootDir, "config/pr-review/schemas/review-findings.schema.json");
  if (fs.existsSync(repoSchema)) {
    return repoSchema;
  }
  return path.join(SHARED_ASSET_ROOT, "schemas", "review-findings.schema.json");
}

function buildReviewerPrompt(templatePath, payload, reviewer, config) {
  const template = readText(templatePath);
  const changedFilesSummary = summarizeChangedFiles(payload.changedFiles);
  return template
    .replaceAll("{{REVIEWER_ID}}", reviewer)
    .replaceAll("{{REVIEWER_ROLE}}", config.reviewerRoles?.[reviewer] || reviewer)
    .replaceAll("{{SCOPE_JSON}}", JSON.stringify(payload.scope, null, 2))
    .replaceAll("{{CHANGED_FILES_SUMMARY}}", changedFilesSummary)
    .replaceAll("{{ACTIVE_STACKS_JSON}}", JSON.stringify(payload.activeStacks, null, 2))
    .replaceAll("{{PROCESS_CHECKS_JSON}}", JSON.stringify(payload.processChecks, null, 2))
    .replaceAll("{{QUALITY_GATES_JSON}}", JSON.stringify(payload.qualityGates, null, 2))
    .replaceAll("{{ADEQUACY_CHECKS_JSON}}", JSON.stringify(payload.adequacyChecks, null, 2))
    .replaceAll("{{FOCUS_JSON}}", JSON.stringify(payload.focus, null, 2))
    .replaceAll("{{CONFIG_JSON}}", JSON.stringify(payload.configSummary, null, 2));
}

function summarizeChangedFiles(changedFiles) {
  const groups = new Map();
  for (const file of changedFiles) {
    const top = file.includes("/") ? file.split("/")[0] : "(root)";
    groups.set(top, (groups.get(top) || 0) + 1);
  }
  const groupSummary = [...groups.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
  const sample = changedFiles.slice(0, 40).map((file) => `- ${file}`).join("\n");
  const remaining = changedFiles.length > 40 ? `\n- ... and ${changedFiles.length - 40} more` : "";
  return [`total=${changedFiles.length}`, `top_dirs=${groupSummary}`, "sample:", sample + remaining].join("\n");
}

function execFilePromise(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function execWithStdinPromise(command, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (child.stdin) {
      child.stdin.end(input);
    }
  });
}

async function runCodexStructuredReviewer(reviewer, payload, config, artifactDir) {
  const schemaPath = resolveSchemaPath(payload.rootDir);
  const promptPath = resolvePromptPath(payload.rootDir, config, reviewer);
  const prompt = buildReviewerPrompt(promptPath, payload, reviewer, config);
  const outputPath = path.join(artifactDir, `${reviewer}.json`);
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-C",
    payload.rootDir,
    "-",
  ];
  const model = config.reviewers?.[reviewer]?.model;
  if (model) {
    args.splice(1, 0, "--model", model);
  }
  const timeout = Number(config.reviewers?.[reviewer]?.timeoutMs || 300000);
  const { stderr } = await execWithStdinPromise("codex", args, prompt, {
    cwd: payload.rootDir,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  const parsed = JSON.parse(readText(outputPath));
  const findings = (parsed.findings || []).map((finding) => normalizeAiFinding(finding, reviewer));
  fs.writeFileSync(path.join(artifactDir, `${reviewer}.stderr.log`), stderr || "");
  return {
    reviewer,
    status: "ok",
    rawOutputPath: outputPath,
    findings,
    summary: String(parsed.summary || `${findings.length} finding(s)`),
  };
}

async function runClaudeStructuredReviewer(reviewer, payload, config, artifactDir) {
  const schemaPath = resolveSchemaPath(payload.rootDir);
  const promptPath = resolvePromptPath(payload.rootDir, config, reviewer);
  const prompt = buildReviewerPrompt(promptPath, payload, reviewer, config);
  const outputPath = path.join(artifactDir, `${reviewer}.json`);
  const schema = JSON.stringify(JSON.parse(readText(schemaPath)));
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--permission-mode",
    "plan",
    "--add-dir",
    payload.rootDir,
  ];
  const model = config.reviewers?.[reviewer]?.model;
  if (model) {
    args.splice(0, 0, "--model", model);
  }
  const timeout = Number(config.reviewers?.[reviewer]?.timeoutMs || 300000);
  const { stdout, stderr } = await execWithStdinPromise("claude", args, prompt, {
    cwd: payload.rootDir,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  fs.writeFileSync(outputPath, stdout);
  fs.writeFileSync(path.join(artifactDir, `${reviewer}.stderr.log`), stderr || "");
  const parsed = JSON.parse(stdout);
  const structured = parsed.structured_output || parsed;
  const findings = (structured.findings || []).map((finding) => normalizeAiFinding(finding, reviewer));
  return {
    reviewer,
    status: "ok",
    rawOutputPath: outputPath,
    findings,
    summary: String(structured.summary || `${findings.length} finding(s)`),
  };
}

async function runExternalReviewer(reviewer, payload, config, artifactDir) {
  const provider = resolveReviewerProvider(reviewer, config);
  if (provider === "codex") {
    return runCodexStructuredReviewer(reviewer, payload, config, artifactDir);
  }
  if (provider === "claude") {
    return runClaudeStructuredReviewer(reviewer, payload, config, artifactDir);
  }
  throw new Error(`Unknown reviewer provider for ${reviewer}`);
}

function safeFailure(reviewer, error, artifactDir) {
  const stderr = [error.message, error.stderr || "", error.stdout || ""].filter(Boolean).join("\n");
  const errorPath = path.join(artifactDir, `${reviewer}.error.log`);
  fs.writeFileSync(errorPath, stderr);
  return {
    reviewer,
    status: "failed",
    rawOutputPath: errorPath,
    findings: [],
    summary: "",
    error: stderr.split("\n")[0],
  };
}

function dedupeFindings(findings) {
  const merged = new Map();
  for (const finding of findings) {
    const key = [
      finding.file || "",
      finding.line || 0,
      finding.title.toLowerCase().replace(/\s+/g, " ").trim(),
      finding.category || "",
    ].join("|");
    if (!merged.has(key)) {
      merged.set(key, { ...finding, reviewers: [finding.reviewer] });
      continue;
    }

    const current = merged.get(key);
    current.reviewers = Array.from(new Set([...current.reviewers, finding.reviewer]));
    if ((finding.confidence || 0) > (current.confidence || 0)) {
      current.confidence = finding.confidence;
      current.detail = finding.detail;
      current.evidence = finding.evidence;
      if (severityRank(finding.severity) < severityRank(current.severity)) {
        current.severity = finding.severity;
      }
    }
  }
  return [...merged.values()];
}

function scoreFinding(finding, deterministicTitles) {
  let score = 0;
  const reviewerSet = new Set(finding.reviewers || [finding.reviewer]);
  if (reviewerSet.has("rule-reviewer")) score += 4;
  if (reviewerSet.size >= 2) score += 3;
  if (finding.file) score += 1;
  if (finding.line) score += 1;
  if (finding.evidence && finding.evidence !== "n/a") score += 1;
  if (finding.severity === "Blocker") score += 2;
  if (deterministicTitles.has(finding.title)) score += 2;
  if ((finding.confidence || 0) >= 0.8) score += 1;
  return score;
}

function isConcreteEnough(finding) {
  return Boolean(finding.file || finding.line || (finding.evidence && finding.evidence !== "n/a"));
}

function isStyleOnlyFinding(finding) {
  return ["style", "formatting", "naming"].includes(String(finding.category || "").toLowerCase());
}

function isMaterialSimplifyFinding(finding) {
  const reviewers = new Set(finding.reviewers || [finding.reviewer]);
  if (!reviewers.has("simplify-reviewer")) {
    return true;
  }
  return isConcreteEnough(finding) && finding.severity !== "Question";
}

function judgeFindings(mergedFindings, ruleRun, config) {
  const accepted = [];
  const rejected = [];
  const deterministicTitles = new Set(ruleRun.normalizedFindings.map((finding) => finding.title));
  const mergeRules = {
    minScoreToAcceptAiOnlyFinding: 4,
    minReviewersForAutoAcceptance: 2,
    preferDeterministicFindings: true,
    requireEvidenceForMajorOrHigher: true,
    rejectStyleOnlyFindings: true,
    acceptSimplifyOnlyWhenChangeIsMaterial: true,
    ...(config.mergeRules || {}),
  };

  for (const finding of mergedFindings) {
    const reviewers = new Set(finding.reviewers || [finding.reviewer]);
    const score = scoreFinding(finding, deterministicTitles);
    const hasRuleSupport = reviewers.has("rule-reviewer");
    const hasConcreteEvidence = isConcreteEnough(finding);
    const autoAcceptedByConsensus = reviewers.size >= Number(mergeRules.minReviewersForAutoAcceptance || 2);
    const acceptedByScore = score >= Number(mergeRules.minScoreToAcceptAiOnlyFinding || 4);

    let rejectionReason = "";
    if (
      mergeRules.requireEvidenceForMajorOrHigher &&
      severityRank(finding.severity) <= severityRank("Major") &&
      !hasConcreteEvidence
    ) {
      rejectionReason = "Major 以上として扱うには file/line/evidence の具体性が不足するため却下";
    } else if (mergeRules.rejectStyleOnlyFindings && isStyleOnlyFinding(finding)) {
      rejectionReason = "style-only の指摘は default policy では採用しないため却下";
    } else if (
      mergeRules.acceptSimplifyOnlyWhenChangeIsMaterial &&
      reviewers.has("simplify-reviewer") &&
      reviewers.size === 1 &&
      !isMaterialSimplifyFinding(finding)
    ) {
      rejectionReason = "simplify-only 指摘だが、変更影響や evidence が弱く一般論に留まるため却下";
    } else if (hasRuleSupport || autoAcceptedByConsensus || acceptedByScore) {
      accepted.push({ ...finding, score });
      continue;
    } else if (score <= 2) {
      rejectionReason = "Diff からの裏付けが弱いか、単独 reviewer の一般論に留まるため却下";
    } else {
      rejectionReason = "他 reviewer との一致または config threshold を満たす evidence が不足するため却下";
    }

    rejected.push({
      ...finding,
      score,
      rejectionReason,
    });
  }

  accepted.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  rejected.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  return { accepted, rejected };
}

function formatReviewerRuns(runs) {
  return runs
    .map((run) => {
      const status = run.status === "ok" ? "PASS" : "FAIL";
      const summary = run.error ? run.error : run.summary;
      return `- \`${run.reviewer}\`: **${status}**${summary ? ` - ${summary}` : ""}`;
    })
    .join("\n");
}

function formatNormalizedFindings(findings) {
  if (!findings.length) {
    return "- なし";
  }
  return findings
    .map((finding) => {
      const loc = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
      const reviewers = finding.reviewers ? ` / reviewers: ${finding.reviewers.join(", ")}` : "";
      return `- [${finding.severity}] ${finding.title}${loc}\n  理由: ${finding.detail}\n  根拠: \`${finding.evidence || "n/a"}\`${reviewers}`;
    })
    .join("\n");
}

function formatRejectedFindings(findings) {
  if (!findings.length) {
    return "- なし";
  }
  return findings
    .map((finding) => `- [${finding.severity}] ${finding.title}\n  却下理由: ${finding.rejectionReason}`)
    .join("\n");
}

function formatQualityGates(qualityGates) {
  return qualityGates
    .map((gate) => `- ${gate.title}: **${gate.status.toUpperCase()}**\n  根拠: \`${gate.evidence}\``)
    .join("\n");
}

function buildFinalMarkdown(result, config) {
  const lines = [];
  lines.push(config.botMarker);
  lines.push(`## ${config.commentTemplate.title}`);
  lines.push("");
  lines.push(`- 対象: ${result.scope.prNumber ? `PR #${result.scope.prNumber}` : "n/a"} (${result.scope.headRef} -> ${result.scope.baseRef})`);
  lines.push(`- タイトル: ${result.scope.prTitle || "n/a"}`);
  lines.push(`- URL: ${result.scope.prUrl || "n/a"}`);
  lines.push(`- 実行コマンド: \`review\``);
  lines.push(`- 有効 reviewer: ${result.runs.map((run) => `\`${run.reviewer}\``).join(", ")}`);
  lines.push("");
  if (config.commentTemplate.includeReviewerRuns) {
    lines.push("### Reviewer Runs");
    lines.push(formatReviewerRuns(result.runs));
    lines.push("");
  }
  lines.push("### Accepted Findings");
  lines.push(formatNormalizedFindings(result.acceptedFindings));
  lines.push("");
  if (config.commentTemplate.includeRejected) {
    lines.push("### Rejected Findings");
    lines.push(formatRejectedFindings(result.rejectedFindings));
    lines.push("");
  }
  if (config.commentTemplate.includeQualityGates) {
    lines.push("### Deterministic Checks");
    lines.push(result.ruleMarkdown.replace(`${config.botMarker}\n`, "").trim());
    lines.push("");
    lines.push("### Quality Gates Snapshot");
    lines.push(formatQualityGates(result.qualityGates));
    lines.push("");
  }
  lines.push("### Reviewer Focus");
  lines.push(result.focus.map((item) => `- ${item}`).join("\n"));
  lines.push("");
  lines.push(`Final decision: **${result.blockerCount > 0 ? "FAIL" : "PASS"}**`);
  return lines.join("\n");
}

function buildRemediationEntries(findings, fixPolicy) {
  return findings.map((finding, index) => {
    const priority =
      finding.severity === "Blocker" ? "Immediate" : finding.severity === "Major" ? "Soon" : "Discuss";
    const location = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "該当箇所を要確認";
    const recommendedChange = [
      `${location} の実装を見直し、`,
      finding.detail.replace(/[。.]?\s*$/, ""),
      " を解消する変更方針を明文化する。",
    ].join("");
    const validationSteps = fixPolicy.includeValidationSteps === false
      ? []
      : [
          finding.file ? `${finding.file} に関連する既存テストと差分の挙動を再確認する` : "変更影響箇所を特定して再確認する",
          "再レビュー時に accepted finding の根拠が消えていることを確認する",
        ];

    return {
      findingId: `finding-${index + 1}`,
      severity: finding.severity,
      priority,
      title: finding.title,
      location,
      recommendedChange,
      reasoning: `採用済み指摘。根拠: ${finding.evidence || "n/a"}`,
      riskNotes:
        finding.severity === "Blocker"
          ? "未対応のまま merge すると重大な回帰または運用リスクが残る。"
          : finding.severity === "Major"
            ? "未対応のまま merge すると仕様不整合や保守性悪化が残る。"
            : "対応優先度は低いが、後続の実装やレビュー負荷を上げる可能性がある。",
      validationSteps,
    };
  });
}

function buildRemediationMarkdown(report, config) {
  const lines = [];
  lines.push(config.remediationMarker);
  lines.push("## PR Review Remediation");
  lines.push("");
  lines.push(`- 対象: ${report.scope.prNumber ? `PR #${report.scope.prNumber}` : "n/a"} (${report.scope.headRef} -> ${report.scope.baseRef})`);
  lines.push(`- ベース: accepted findings ${report.acceptedFindings.length} 件`);
  lines.push(`- 方針: ${config.fixPolicy?.mode || "comment-only"}`);
  lines.push("");
  if (!report.entries.length) {
    lines.push("- remediation 対象はありません。");
    return lines.join("\n");
  }
  for (const entry of report.entries) {
    lines.push(`### ${entry.findingId}: [${entry.severity}] ${entry.title}`);
    lines.push(`- 優先度: ${entry.priority}`);
    lines.push(`- 位置: ${entry.location}`);
    lines.push(`- 推奨対応: ${entry.recommendedChange}`);
    lines.push(`- 理由: ${entry.reasoning}`);
    lines.push(`- リスク: ${entry.riskNotes}`);
    if (entry.validationSteps.length) {
      lines.push(`- 確認: ${entry.validationSteps.join(" / ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function selectReviewers(args, config) {
  if (args.reviewers) {
    return args.reviewers.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return config.enabledReviewers.filter((reviewer) => reviewer !== "review-judge");
}

function getRepoSlug(cwd) {
  try {
    return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function upsertPrComment(scope, body, cwd, marker) {
  const repo = getRepoSlug(cwd);
  if (!repo || !scope.prNumber) {
    throw new Error("PR comment posting requires GitHub repo context and PR number.");
  }
  const comments = JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/issues/${scope.prNumber}/comments`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const existing = comments.find((comment) => comment.user?.type === "Bot" && String(comment.body || "").includes(marker));
  if (existing) {
    execFileSync(
      "gh",
      ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "-f", `body=${body}`],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    return;
  }
  execFileSync(
    "gh",
    ["api", "--method", "POST", `repos/${repo}/issues/${scope.prNumber}/comments`, "-f", `body=${body}`],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function buildSharedReviewContext(args, event, context, config, rootDir) {
  const runtime = createRuntime(rootDir);
  const scope = runtime.resolveScope(event, context, args);
  const changedFiles = runtime.getChangedFiles(scope, context);
  const addedLines = runtime.getDiffLines(scope, "+");
  const pkg = runtime.getPackageJson(config);
  const activeStacks = runtime.getActiveStacks(changedFiles, config);
  const checks = runtime.runProcessChecks(scope, pkg, config);
  const { adequacyChecks } = runtime.buildTestAdequacy(changedFiles, config, activeStacks);
  const qualityGates = runtime.buildQualityGates(context, pkg, config);
  const focus = runtime.buildReviewerFocus(activeStacks, config);
  return {
    runtime,
    scope,
    changedFiles,
    addedLines,
    pkg,
    activeStacks,
    checks,
    adequacyChecks,
    qualityGates,
    focus,
  };
}

function buildRuleRun(shared, config) {
  const findings = shared.runtime.buildFindings(
    shared.scope,
    shared.changedFiles,
    shared.addedLines,
    shared.checks,
    shared.adequacyChecks,
    shared.qualityGates,
    shared.activeStacks,
    config,
  ).findings;
  const markdown = buildMarkdown(
    shared.scope,
    shared.changedFiles,
    shared.checks,
    shared.adequacyChecks,
    shared.qualityGates,
    findings,
    shared.focus,
    config,
    shared.activeStacks,
  );
  const normalizedFindings = findings.map((finding) => normalizeRuleFinding(finding));
  const blockers = findings.filter((finding) => finding.severity === "Blocker").length;
  return {
    reviewer: "rule-reviewer",
    status: "ok",
    rawOutputPath: "",
    findings: normalizedFindings,
    normalizedFindings,
    summary: `Checks: ${shared.checks.length}, Findings: ${findings.length}, Blockers: ${blockers}`,
    blockers,
    markdown,
    checks: shared.checks,
    adequacyChecks: shared.adequacyChecks,
    qualityGates: shared.qualityGates,
    focus: shared.focus,
  };
}

function buildReviewerPayload(shared, config, rootDir) {
  return {
    rootDir,
    scope: shared.scope,
    changedFiles: shared.changedFiles,
    activeStacks: shared.activeStacks,
    processChecks: shared.checks,
    adequacyChecks: shared.adequacyChecks,
    qualityGates: shared.qualityGates,
    focus: shared.focus,
    configSummary: {
      packageJsonPath: config.packageJsonPath,
      enabledStacks: config.enabledStacks,
      reviewerRoles: config.reviewerRoles,
      mergeRules: config.mergeRules,
      failurePolicy: config.failurePolicy,
      fixPolicy: config.fixPolicy,
    },
  };
}

async function runReviewCommand(args, rootDir, config, event, context) {
  const shared = buildSharedReviewContext(args, event, context, config, rootDir);
  const artifactBase = args["artifacts-dir"] || config.reviewers?.artifactsDir || path.join(".agent", "pr-review");
  const runSlug = stableSlug(shared.scope.prNumber || `${shared.scope.headRef}-vs-${shared.scope.baseRef}`);
  const artifactDir = path.join(rootDir, artifactBase, runSlug);
  ensureDir(artifactDir);

  const reviewerPayload = buildReviewerPayload(shared, config, rootDir);
  const selectedReviewers = selectReviewers(args, config);
  const tasks = selectedReviewers.map(async (reviewer) => {
    if (reviewer === "rule-reviewer") {
      const ruleRun = buildRuleRun(shared, config);
      ruleRun.rawOutputPath = path.join(artifactDir, "rule-review.md");
      return ruleRun;
    }
    try {
      return await runExternalReviewer(reviewer, reviewerPayload, config, artifactDir);
    } catch (error) {
      return safeFailure(reviewer, error, artifactDir);
    }
  });

  const runs = await Promise.allSettled(tasks);
  const normalizedRuns = runs.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return safeFailure(selectedReviewers[index], result.reason, artifactDir);
  });

  const ruleRun = normalizedRuns.find((run) => run.reviewer === "rule-reviewer") || buildRuleRun(shared, config);
  fs.writeFileSync(path.join(artifactDir, "rule-review.md"), ruleRun.markdown);
  writeJson(path.join(artifactDir, "rule-review.json"), {
    checks: ruleRun.checks,
    adequacyChecks: ruleRun.adequacyChecks,
    qualityGates: ruleRun.qualityGates,
    findings: ruleRun.normalizedFindings,
  });

  const mergedFindings = dedupeFindings(normalizedRuns.flatMap((run) => run.findings || []));
  const judged = judgeFindings(mergedFindings, ruleRun, config);
  const blockerSeverities = new Set(config.failurePolicy?.failOnSeverities || ["Blocker"]);
  const blockerCount = judged.accepted.filter((finding) => blockerSeverities.has(finding.severity)).length;

  const finalResult = {
    command: "review",
    scope: shared.scope,
    runs: normalizedRuns,
    acceptedFindings: judged.accepted,
    rejectedFindings: judged.rejected,
    blockerCount,
    qualityGates: shared.qualityGates,
    focus: shared.focus,
    ruleMarkdown: ruleRun.markdown,
  };
  const markdown = buildFinalMarkdown(finalResult, config);
  const outputPath = args.output ? path.resolve(rootDir, args.output) : path.join(artifactDir, "final-review.md");
  writeOutput(outputPath, markdown);
  writeJson(path.join(artifactDir, "final-review.json"), finalResult);

  if (args["post-comment"] === "true") {
    upsertPrComment(shared.scope, markdown, rootDir, config.botMarker);
  }

  console.error(`Unified review completed. Accepted: ${judged.accepted.length}, Blockers: ${blockerCount}`);
  process.exit(blockerCount > 0 ? 1 : 0);
}

function loadFinalReviewForFix(args, rootDir, config, scope) {
  if (args.input) {
    return JSON.parse(readText(path.resolve(rootDir, args.input)));
  }
  const artifactBase = args["artifacts-dir"] || config.reviewers?.artifactsDir || path.join(".agent", "pr-review");
  const runSlug = stableSlug(scope.prNumber || `${scope.headRef}-vs-${scope.baseRef}`);
  const reportPath = path.join(rootDir, artifactBase, runSlug, "final-review.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`final-review.json not found for remediation: ${reportPath}`);
  }
  return JSON.parse(readText(reportPath));
}

function runFixCommand(args, rootDir, config, event, context) {
  const shared = buildSharedReviewContext(args, event, context, config, rootDir);
  const artifactBase = args["artifacts-dir"] || config.reviewers?.artifactsDir || path.join(".agent", "pr-review");
  const runSlug = stableSlug(shared.scope.prNumber || `${shared.scope.headRef}-vs-${shared.scope.baseRef}`);
  const artifactDir = path.join(rootDir, artifactBase, runSlug);
  ensureDir(artifactDir);

  const finalReview = loadFinalReviewForFix(args, rootDir, config, shared.scope);
  const entries = buildRemediationEntries(finalReview.acceptedFindings || [], config.fixPolicy || {});
  const remediationReport = {
    command: "fix-review-comments",
    sourceReportPath: args.input || path.join(artifactDir, "final-review.json"),
    scope: finalReview.scope || shared.scope,
    acceptedFindings: finalReview.acceptedFindings || [],
    entries,
  };
  const markdown = buildRemediationMarkdown(remediationReport, config);
  const outputPath = args.output ? path.resolve(rootDir, args.output) : path.join(artifactDir, "remediation-review.md");
  writeOutput(outputPath, markdown);
  writeJson(path.join(artifactDir, "remediation-review.json"), remediationReport);

  if (args["post-comment"] === "true") {
    upsertPrComment(shared.scope, markdown, rootDir, config.remediationMarker);
  }

  console.error(`Remediation review completed. Entries: ${entries.length}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const command = resolveCommand(args);
  const rootDir = resolveRepoRoot(args);
  const runtime = createRuntime(rootDir);
  const config = runtime.loadConfig(args.config || process.env.PR_REVIEW_CONFIG);
  const event = readEvent(args["event-path"] || process.env.GITHUB_EVENT_PATH);
  const context = readContext(args["context-path"] || process.env.PR_CONTEXT_PATH);

  if (command === "review") {
    await runReviewCommand(args, rootDir, config, event, context);
    return;
  }

  if (command === "fix-review-comments") {
    runFixCommand(args, rootDir, config, event, context);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
