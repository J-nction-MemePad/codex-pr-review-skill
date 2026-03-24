"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { STACK_MODULES, DEFAULT_TEST_GROUPS } = require("../pr-review-core/module-library");

const DEFAULT_BOT_MARKER = "<!-- pr-review-bot -->";
const SECRET_ENV_PATTERN =
  /(PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|PRIVY_APP_SECRET|JWT_SECRET)\s*=\s*.+/;
const CODE_SECRET_PATTERN =
  /(privateKey|apiKey|secret|token)\s*[:=]\s*["'`][^"'`\s]{16,}/;
const INPUT_VALIDATION_PATTERN =
  /zod|safeParse|parse\(|schema|validator|emailRegex|isValidAddress|typeof .*===/;
const SECURITY_DANGER_PATTERN =
  /dangerouslySetInnerHTML|eval\(|new Function\(|innerHTML\s*=|child_process|execSync\(/;
const TYPE_ESCAPE_PATTERN = /@ts-ignore|@ts-expect-error|\bas any\b|:\s*any\b|<any>/;
const DEBUG_LOG_PATTERN = /console\.(log|debug)\(|writeFileSync\(/;
const DISABLE_LINT_PATTERN = /eslint-disable/;
const SELECT_ALL_PATTERN = /\.select\(\s*["'`]\*["'`]\s*\)/;
const SEQUENTIAL_LOOP_PATTERN = /\bfor\s*\(|\bfor\s*\(const .* of /;
const DIRECT_ENV_PATTERN = /process\.env\.[A-Z0-9_]+/;
const DEPRECATED_PATTERN = /\bdeprecated\b/i;

function createRuntime(rootDir) {
  const repoFiles = walkDir(rootDir);

  function git(args, options = {}) {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  }

  function tryGit(args) {
    try {
      return git(args);
    } catch {
      return "";
    }
  }

  function relative(filePath) {
    return path.relative(rootDir, filePath).replaceAll(path.sep, "/");
  }

  function findFiles(predicate) {
    return repoFiles.map((filePath) => relative(filePath)).filter((repoPath) => predicate(repoPath));
  }

  function getPackageJsonPath(config) {
    return path.join(rootDir, config.packageJsonPath || "package.json");
  }

  function getPackageJson(config) {
    return readJson(getPackageJsonPath(config));
  }

  function getBasePackageJson(scope, config) {
    const packagePath = (config.packageJsonPath || "package.json").replaceAll(path.sep, "/");
    const raw = tryGit(["show", `${scope.baseSha}:${packagePath}`]);
    return raw ? JSON.parse(raw) : null;
  }

  function getChangedFileContents(changedFiles) {
    const contents = new Map();
    for (const file of changedFiles) {
      const fullPath = path.join(rootDir, file);
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      contents.set(file, fs.readFileSync(fullPath, "utf8"));
    }
    return contents;
  }

  function scanRepo(pattern, options = {}) {
    const matches = [];
    for (const filePath of repoFiles) {
      const repoPath = relative(filePath);
      if (options.include && !options.include(repoPath)) {
        continue;
      }
      if (options.exclude && options.exclude(repoPath)) {
        continue;
      }
      const lines = readLines(filePath);
      lines.forEach((line, index) => {
        if (!pattern.test(line)) {
          return;
        }
        if (options.ignoreComments && isCommentLine(line)) {
          return;
        }
        matches.push({
          file: repoPath,
          line: index + 1,
          text: line.trim(),
        });
      });
    }
    return matches;
  }

  function listMatchingFiles(patterns, excludePatterns = []) {
    const includes = compilePatterns(patterns);
    const excludes = compilePatterns(excludePatterns);
    return findFiles(
      (repoPath) =>
        includes.some((pattern) => pattern.test(repoPath)) &&
        !excludes.some((pattern) => pattern.test(repoPath)),
    );
  }

  function loadConfig(configPathArg) {
    const configPath = configPathArg
      ? path.resolve(rootDir, configPathArg)
      : path.join(rootDir, "config/pr-review/repo-config.json");
    if (!fs.existsSync(configPath)) {
      throw new Error(`PR review config not found: ${configPath}`);
    }

    const raw = readJson(configPath);
    const enabledStacks = raw.enabledStacks || [];
    if (!enabledStacks.length) {
      throw new Error("enabledStacks is required in PR review config.");
    }

    const stacks = {};
    for (const stackId of enabledStacks) {
      const base = STACK_MODULES[stackId];
      if (!base) {
        throw new Error(`Unknown stack module: ${stackId}`);
      }
      const override = raw.stacks?.[stackId] || {};
      stacks[stackId] = {
        ...base,
        ...override,
        changeMatchers: override.changeMatchers || base.changeMatchers || [],
        adequacy: base.adequacy || override.adequacy
          ? {
              ...(base.adequacy || {}),
              ...(override.adequacy || {}),
              testGroups:
                override.adequacy?.testGroups ||
                base.adequacy?.testGroups ||
                [],
            }
          : null,
        reviewerFocus: override.reviewerFocus || base.reviewerFocus,
      };
    }

    const commentTemplate = raw.commentTemplate || {};
    const reviewers = raw.reviewers || {};

    return {
      path: configPath,
      language: raw.language || "ja",
      botMarker: raw.botMarker || DEFAULT_BOT_MARKER,
      remediationMarker: raw.remediationMarker || "<!-- pr-review-remediation-bot -->",
      packageJsonPath: raw.packageJsonPath || "package.json",
      branchPattern: raw.branchPattern || "^(feature|fix|chore|hotfix|docs|release)\\/[a-z0-9][a-z0-9._-]*$",
      branchExclusions: raw.branchExclusions || ["main", "develop"],
      enabledStacks,
      stacks,
      matchers: raw.matchers || {},
      testGroups: {
        ...DEFAULT_TEST_GROUPS,
        ...(raw.testGroups || {}),
      },
      processChecks: raw.processChecks || [],
      qualityGates: raw.qualityGates || [],
      severityPolicy: raw.severityPolicy || {},
      enabledReviewers:
        raw.enabledReviewers || ["rule-reviewer", "codex-reviewer", "simplify-reviewer", "review-judge"],
      reviewerRoles: raw.reviewerRoles || {
        "rule-reviewer": "deterministic repo checks and heuristics",
        "codex-reviewer": "correctness, regressions, missing tests, security, CI breakage",
        "simplify-reviewer": "readability, unnecessary abstraction, overengineering, maintainability",
        "review-judge": "finding arbitration and severity normalization",
      },
      reviewers,
      mergeRules: raw.mergeRules || {},
      failurePolicy: raw.failurePolicy || { failOnSeverities: ["Blocker"] },
      fixPolicy: raw.fixPolicy || {
        mode: "comment-only",
        includeValidationSteps: true,
      },
      commentTemplate: {
        includeAccepted: commentTemplate.includeAccepted !== false,
        includeRejected: commentTemplate.includeRejected !== false,
        includeReviewerRuns: commentTemplate.includeReviewerRuns !== false,
        includeQualityGates: commentTemplate.includeQualityGates !== false,
        bilingual: commentTemplate.bilingual === true,
        title: commentTemplate.title || "Unified PR Review",
      },
    };
  }

  function resolveScope(event, context, args) {
    const pullRequest = event && event.pull_request ? event.pull_request : null;
    const headRef =
      args.head ||
      process.env.HEAD_REF ||
      context?.headRefName ||
      (pullRequest ? pullRequest.head.ref : tryGit(["rev-parse", "--abbrev-ref", "HEAD"]));
    const baseRef =
      args.base ||
      process.env.BASE_REF ||
      context?.baseRefName ||
      (pullRequest ? pullRequest.base.ref : "main");
    const headSha =
      args["head-sha"] ||
      process.env.HEAD_SHA ||
      context?.headRefOid ||
      (pullRequest ? pullRequest.head.sha : tryGit(["rev-parse", "HEAD"]));
    const baseSha =
      args["base-sha"] ||
      process.env.BASE_SHA ||
      context?.baseRefOid ||
      (pullRequest
        ? pullRequest.base.sha
        : tryGit(["merge-base", headSha, baseRef]) ||
          tryGit(["merge-base", headSha, `origin/${baseRef}`]));
    const prNumber =
      args.pr ||
      process.env.PR_NUMBER ||
      (pullRequest ? String(pullRequest.number) : context?.number ? String(context.number) : "");
    const prTitle = pullRequest ? pullRequest.title : context?.title || args.title || "";
    const prUrl = pullRequest ? pullRequest.html_url : context?.url || args.url || "";

    if (!headRef || !baseRef || !headSha || !baseSha) {
      throw new Error("Unable to resolve PR scope. Provide event payload or base/head refs.");
    }

    return {
      prNumber,
      prTitle,
      prUrl,
      headRef,
      baseRef,
      headSha,
      baseSha,
    };
  }

  function getChangedFiles(scope, context) {
    if (context?.files?.length) {
      return context.files
        .map((file) => (typeof file === "string" ? file : file.path))
        .filter(Boolean);
    }
    const output = git(["diff", "--name-only", `${scope.baseSha}...${scope.headSha}`]);
    return output ? output.split("\n").filter(Boolean) : [];
  }

  function getDiffLines(scope, prefix) {
    const diff = tryGit(["diff", "--unified=0", `${scope.baseSha}...${scope.headSha}`]);
    const lines = [];
    let currentFile = "";
    const filePrefix = prefix === "+" ? "+++ b/" : "--- a/";

    for (const line of diff.split("\n")) {
      if (line.startsWith(filePrefix)) {
        currentFile = line.slice(6);
        continue;
      }
      if (!currentFile || !line.startsWith(prefix) || line.startsWith(filePrefix)) {
        continue;
      }
      lines.push({
        file: currentFile,
        text: line.slice(1),
      });
    }

    return lines;
  }

  function getActiveStacks(changedFiles, config) {
    const active = {};
    for (const [stackId, stack] of Object.entries(config.stacks)) {
      const matchers = compilePatterns(stack.changeMatchers);
      active[stackId] = matchers.length
        ? changedFiles.some((file) => matchers.some((pattern) => pattern.test(file)))
        : false;
    }
    return active;
  }

  function hasDependency(pkg, dependencyName) {
    return (
      (pkg.dependencies && pkg.dependencies[dependencyName]) ||
      (pkg.devDependencies && pkg.devDependencies[dependencyName])
    );
  }

  function getScriptsByNames(pkg, names = []) {
    return names
      .filter((name) => pkg.scripts?.[name])
      .map((name) => `${name}=${pkg.scripts[name]}`);
  }

  function getScriptsByMatchers(pkg, matchers = []) {
    const entries = Object.entries(pkg.scripts || {});
    const matched = [];

    for (const entry of entries) {
      const [key, value] = entry;
      if (
        matchers.some((matcher) => {
          if (matcher.key && matcher.key === key) return true;
          if (matcher.keyPattern && new RegExp(matcher.keyPattern).test(key)) return true;
          if (matcher.valuePattern && new RegExp(matcher.valuePattern).test(value)) return true;
          return false;
        })
      ) {
        matched.push(`${key}=${value}`);
      }
    }

    return unique(matched);
  }

  function normalizeGateStatus(item) {
    if (!item) {
      return "needs-info";
    }

    if (item.__typename === "StatusContext") {
      if (item.state === "SUCCESS") return "pass";
      if (item.state === "PENDING") return "needs-info";
      return "fail";
    }

    if (item.status !== "COMPLETED") {
      return "needs-info";
    }

    if (item.conclusion === "SUCCESS") return "pass";
    if (item.conclusion === "SKIPPED") return "needs-info";
    return "fail";
  }

  function evaluateProcessCheck(check, scope, pkg, config) {
    if (check.type === "branch-pattern") {
      const pattern = compilePattern(check.pattern || config.branchPattern);
      const excluded = check.excludeBranches || config.branchExclusions || [];
      const status =
        pattern.test(scope.headRef) && !excluded.includes(scope.headRef) ? "pass" : "fail";
      return createCheck(check.id, check.title, status, `head=${scope.headRef}`, check.details);
    }

    if (check.type === "repo-foundation") {
      const dependencies = (check.dependencyNames || []).map((name) => hasDependency(pkg, name));
      const configs = listMatchingFiles(check.configPatterns || []);
      const scripts = getScriptsByNames(pkg, check.scriptNames || []);
      const repoTests = check.repoTestGroup
        ? listMatchingFiles(
            config.testGroups[check.repoTestGroup]?.patterns || [],
            config.testGroups[check.repoTestGroup]?.exclude || [],
          )
        : [];

      const status =
        dependencies.every(Boolean) &&
        (!check.configPatterns?.length || configs.length > 0) &&
        (!check.scriptNames?.length || scripts.length > 0) &&
        (!check.repoTestGroup || repoTests.length > 0)
          ? "pass"
          : "fail";

      return createCheck(
        check.id,
        check.title,
        status,
        [
          ...(check.dependencyNames || []).map((name, index) =>
            dependencies[index] ? `dep=${name}` : `dep:${name}=missing`,
          ),
          check.configPatterns?.length
            ? configs[0]
              ? `config=${configs[0]}`
              : "config=missing"
            : null,
          check.repoTestGroup
            ? repoTests[0]
              ? `test=${repoTests[0]}`
              : "test=missing"
            : null,
          check.scriptNames?.length
            ? scripts[0]
              ? `script=${scripts[0]}`
              : "script=missing"
            : null,
        ]
          .filter(Boolean)
          .join(", "),
        check.details,
      );
    }

    if (check.type === "script-plus-repo-signal") {
      const scripts = getScriptsByMatchers(pkg, check.scriptMatchers || []);
      const signalInclude = compilePatterns(check.signalIncludePatterns || []);
      const signalExclude = compilePatterns(check.signalExcludePatterns || []);
      const signals = scanRepo(compilePattern(check.repoSignalPattern), {
        include: (repoPath) =>
          !signalInclude.length || signalInclude.some((pattern) => pattern.test(repoPath)),
        exclude: (repoPath) => signalExclude.some((pattern) => pattern.test(repoPath)),
        ignoreComments: check.ignoreComments !== false,
      });
      const status = scripts.length && signals.length ? "pass" : "fail";
      return createCheck(
        check.id,
        check.title,
        status,
        [
          scripts[0] ? `script=${scripts[0]}` : "script=missing",
          signals[0] ? `signal=${signals[0].file}:${signals[0].line}` : "signal=missing",
        ].join(", "),
        check.details,
      );
    }

    if (check.type === "hardhat-solidity-foundation") {
      const hasDeps = (check.dependencyNames || []).every((name) => hasDependency(pkg, name));
      const testFiles = listMatchingFiles(
        config.testGroups[check.repoTestGroup]?.patterns || [],
        config.testGroups[check.repoTestGroup]?.exclude || [],
      );
      const coverageScript = Object.entries(pkg.scripts || {}).find(([, value]) =>
        new RegExp(check.coverageScriptPattern).test(value),
      );
      const thresholdSignals = scanRepo(compilePattern(check.thresholdPattern), {
        include: (repoPath) =>
          !check.thresholdIncludePatterns?.length ||
          compilePatterns(check.thresholdIncludePatterns).some((pattern) => pattern.test(repoPath)),
      });

      const status =
        hasDeps &&
        testFiles.length > 0 &&
        Boolean(coverageScript) &&
        thresholdSignals.length > 0
          ? "pass"
          : "fail";

      return createCheck(
        check.id,
        check.title,
        status,
        [
          testFiles[0] ? `test=${testFiles[0]}` : "test=missing",
          coverageScript ? `coverage=${coverageScript[0]}=${coverageScript[1]}` : "coverage=missing",
          thresholdSignals[0]
            ? `threshold=${thresholdSignals[0].file}:${thresholdSignals[0].line}`
            : "threshold=missing",
        ].join(", "),
        check.details,
      );
    }

    if (check.type === "foundry-solidity-foundation") {
      const configs = listMatchingFiles(check.configPatterns || ["^contracts/foundry\\.toml$"]);
      const testFiles = listMatchingFiles(
        config.testGroups[check.repoTestGroup]?.patterns || [],
        config.testGroups[check.repoTestGroup]?.exclude || [],
      );
      const status = configs.length > 0 && testFiles.length > 0 ? "pass" : "fail";
      return createCheck(
        check.id,
        check.title,
        status,
        [
          configs[0] ? `config=${configs[0]}` : "config=missing",
          testFiles[0] ? `test=${testFiles[0]}` : "test=missing",
        ].join(", "),
        check.details,
      );
    }

    throw new Error(`Unsupported process check type: ${check.type}`);
  }

  function runProcessChecks(scope, pkg, config) {
    return config.processChecks.map((check) => evaluateProcessCheck(check, scope, pkg, config));
  }

  function buildTestAdequacy(changedFiles, config, activeStacks) {
    const docsOnlyPatterns = compilePatterns(config.matchers.docsOnly);
    const lockfilePatterns = compilePatterns(config.matchers.lockfiles);
    const docsOnly =
      changedFiles.length > 0 &&
      changedFiles.every(
        (file) => isAnyMatch(file, docsOnlyPatterns) || isAnyMatch(file, lockfilePatterns),
      );
    const lockfileOnly =
      changedFiles.length > 0 && changedFiles.every((file) => isAnyMatch(file, lockfilePatterns));
    const changedTests = getChangedTestFiles(changedFiles, config.testGroups);
    const adequacyChecks = [];

    if (changedFiles.length === 0) {
      adequacyChecks.push(
        createAdequacyCheck(
          "empty",
          "変更内容に対するテスト妥当性",
          "needs-info",
          "変更ファイルがある前提",
          "変更ファイルなし",
          "空コミットまたは差分解決後の PR の可能性があります。",
        ),
      );
      return { adequacyChecks, changedTests, docsOnly, lockfileOnly };
    }

    if (docsOnly || lockfileOnly) {
      adequacyChecks.push(
        createAdequacyCheck(
          "docs-lock",
          "ドキュメント / lockfile 変更",
          "pass",
          "追加テストは通常不要",
          changedTests.any?.length ? changedTests.any.join(", ") : "テスト更新なし",
          "docs-only または lockfile-only の変更として扱います。",
        ),
      );
      return { adequacyChecks, changedTests, docsOnly, lockfileOnly };
    }

    for (const [stackId, stack] of Object.entries(config.stacks)) {
      if (!activeStacks[stackId] || !stack.adequacy) {
        continue;
      }
      const actual = unique(
        (stack.adequacy.testGroups || []).flatMap((groupId) => changedTests[groupId] || []),
      );
      const status = actual.length ? "pass" : stack.adequacy.missingStatus || "fail";
      adequacyChecks.push(
        createAdequacyCheck(
          stack.adequacy.id || stackId,
          stack.adequacy.title || `${stack.title} 変更に対するテスト更新`,
          status,
          stack.adequacy.expected || "関連テスト更新",
          actual.length ? actual.join(", ") : "関連テスト更新なし",
          stack.adequacy.details || "",
        ),
      );
    }

    return { adequacyChecks, changedTests, docsOnly, lockfileOnly };
  }

  function findRollupItem(rollup, matchers) {
    return rollup.find((item) =>
      matchers.some((matcher) =>
        Object.entries(matcher).every(([key, value]) => item?.[key] === value),
      ),
    );
  }

  function buildQualityGates(context, pkg, config) {
    const rollup = context?.statusCheckRollup || [];
    return config.qualityGates.map((gate) => {
      if (gate.type === "package-script") {
        return createGate(
          gate.id,
          gate.title,
          pkg.scripts?.[gate.script] ? "pass" : "fail",
          pkg.scripts?.[gate.script] ? `script=${gate.script}:${pkg.scripts[gate.script]}` : "script=missing",
          gate.details,
        );
      }

      if (gate.type === "runtime-check") {
        const item = findRollupItem(rollup, gate.matchers || []);
        return createGate(
          gate.id,
          gate.title,
          normalizeGateStatus(item),
          item?.detailsUrl || item?.targetUrl || "signal=missing",
          item ? `${item.workflowName || item.name || item.context}` : gate.details,
        );
      }

      throw new Error(`Unsupported quality gate type: ${gate.type}`);
    });
  }

  function hasValidationEvidence(changedFiles, addedLines, config) {
    const apiMatchers = compilePatterns(config.matchers?.apiRoutes);
    const validationFiles = unique(
      addedLines
        .filter(
          ({ file, text }) =>
            changedFiles.includes(file) &&
            apiMatchers.some((pattern) => pattern.test(file)) &&
            INPUT_VALIDATION_PATTERN.test(text),
        )
        .map(({ file }) => file),
    );
    return validationFiles;
  }

  function buildFindings(scope, changedFiles, addedLines, checks, adequacyChecks, qualityGates, activeStacks, config) {
    const findings = [];
    const changedContents = getChangedFileContents(changedFiles);

    const failedChecks = checks.filter((check) => check.status === "fail");
    if (failedChecks.length) {
      findings.push({
        severity: "Blocker",
        title: "必須プロセスチェックを満たしていません",
        detail: `失敗したチェック: ${failedChecks.map((check) => check.title).join(", ")}`,
        evidence: failedChecks.map((check) => `${check.id}: ${check.evidence}`).join(" | "),
      });
    }

    for (const adequacyCheck of adequacyChecks.filter((item) => item.status === "fail")) {
      findings.push({
        severity: "Blocker",
        title: `${adequacyCheck.title} が不足しています`,
        detail: `${adequacyCheck.details} 期待: ${adequacyCheck.expected}`,
        evidence: adequacyCheck.actual || "関連更新なし",
      });
    }

    for (const qualityGate of qualityGates.filter((item) => item.status === "fail" && item.id !== "pr-review")) {
      findings.push({
        severity: "Blocker",
        title: `${qualityGate.title} が失敗または未設定です`,
        detail: qualityGate.details,
        evidence: qualityGate.evidence,
      });
    }

    for (const qualityGate of qualityGates.filter((item) => item.status === "needs-info")) {
      findings.push({
        severity: "Question",
        title: `${qualityGate.title} の最終状態を確認してください`,
        detail: qualityGate.details,
        evidence: qualityGate.evidence,
      });
    }

    const apiMatchers = compilePatterns(config.matchers.apiRoutes);
    if (
      apiMatchers.length &&
      changedFiles.some((file) => apiMatchers.some((pattern) => pattern.test(file)))
    ) {
      const validatedFiles = hasValidationEvidence(changedFiles, addedLines, config);
      if (validatedFiles.length === 0) {
        findings.push({
          severity: "Blocker",
          title: "API 変更に入力検証の追加根拠が見当たりません",
          detail: "新しい入力項目や処理分岐を追加した場合、zod などの明示的バリデーションの痕跡が必要です。",
          evidence: unique(
            changedFiles.filter((file) => apiMatchers.some((pattern) => pattern.test(file))),
          ).join(", "),
        });
      }
    }

    const dangerousPatterns = countByFile(
      addedLines,
      ({ file, text }) =>
        !/\.md$/.test(file) &&
        !file.startsWith("scripts/") &&
        !isHeuristicExcluded(file, config) &&
        SECURITY_DANGER_PATTERN.test(text),
    );
    if (dangerousPatterns.length) {
      findings.push({
        severity: "Blocker",
        title: "危険な実行・描画パターンが差分に含まれています",
        detail: "dangerouslySetInnerHTML、eval、new Function、innerHTML 直接代入、child_process 実行は厳しくレビューすべきです。",
        evidence: dangerousPatterns.join(", "),
      });
    }

    const performanceFiles = unique(
      changedFiles.filter((file) => {
        if (file.startsWith("scripts/") || file.endsWith(".md")) {
          return false;
        }
        const content = changedContents.get(file) || "";
        return (
          (SEQUENTIAL_LOOP_PATTERN.test(content) &&
            /await\s+/.test(content) &&
            /\.from\(|fetch\(|axios\./.test(content)) ||
          SELECT_ALL_PATTERN.test(content)
        );
      }),
    );
    if (performanceFiles.length) {
      findings.push({
        severity: "Major",
        title: "性能劣化の兆候がある変更です",
        detail: "ループ内の逐次 await、`select('*')`、または重いデータ取得が追加されていないか確認してください。",
        evidence: performanceFiles.join(", "),
      });
    }

    const oversizedFiles = unique(
      changedFiles.filter((file) => {
        const content = changedContents.get(file);
        if (!content) return false;
        const lineCount = content.split(/\r?\n/).length;
        return lineCount > 350 && (/^app\//.test(file) || /^components\//.test(file) || /^lib\//.test(file) || /^ui\/src\//.test(file));
      }),
    );
    if (oversizedFiles.length) {
      findings.push({
        severity: "Major",
        title: "責務が大きすぎるファイル変更が含まれています",
        detail: "大きな route/component/lib 変更は責務分割や共通化の余地を確認してください。",
        evidence: oversizedFiles.join(", "),
      });
    }

    const directEnvFiles = countByFile(
      addedLines,
      ({ file, text }) =>
        !isHeuristicExcluded(file, config) &&
        !isAnyMatch(file, compilePatterns(config.matchers.envValidationExclusions)) &&
        DIRECT_ENV_PATTERN.test(text),
    );
    if (directEnvFiles.length >= 3) {
      findings.push({
        severity: "Major",
        title: "環境変数参照が差分に散在しています",
        detail: "env 参照は共通ヘルパーや validation 層へ寄せる方が保守しやすいです。",
        evidence: directEnvFiles.join(", "),
      });
    }

    const typeEscapes = countByFile(
      addedLines,
      ({ file, text }) =>
        !/\.md$/.test(file) && !isHeuristicExcluded(file, config) && TYPE_ESCAPE_PATTERN.test(text),
    );
    if (typeEscapes.length) {
      findings.push({
        severity: "Major",
        title: "型逃がしが差分に追加されています",
        detail: "`any`、`@ts-ignore`、`@ts-expect-error` は恒久化せず、型を整備する方向で扱うべきです。",
        evidence: typeEscapes.join(", "),
      });
    }

    const lintDisables = countByFile(
      addedLines,
      ({ file, text }) =>
        !/\.md$/.test(file) && !isHeuristicExcluded(file, config) && DISABLE_LINT_PATTERN.test(text),
    );
    if (lintDisables.length) {
      findings.push({
        severity: "Minor",
        title: "lint rule の無効化が追加されています",
        detail: "eslint-disable は理由付きで最小範囲に限定すべきです。",
        evidence: lintDisables.join(", "),
      });
    }

    const deprecatedUsage = countByFile(
      addedLines,
      ({ file, text }) =>
        !/\.md$/.test(file) && !isHeuristicExcluded(file, config) && DEPRECATED_PATTERN.test(text),
    );
    if (deprecatedUsage.length) {
      findings.push({
        severity: "Minor",
        title: "deprecated な要素を前提にした変更が含まれています",
        detail: "非推奨 API や非推奨依存を新規に広げていないか確認してください。",
        evidence: deprecatedUsage.join(", "),
      });
    }

    if (activeStacks.dependencies) {
      const packageJsonRepoPath = config.packageJsonPath || "package.json";
      const pkgChanged = changedFiles.includes(packageJsonRepoPath);
      const lockChanged = changedFiles.some((file) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/.test(file));
      let addedDeps = [];

      if (pkgChanged) {
        const basePkg = getBasePackageJson(scope, config);
        if (basePkg) {
          const currentPkg = getPackageJson(config);
          const before = {
            ...(basePkg.dependencies || {}),
            ...(basePkg.devDependencies || {}),
          };
          const after = {
            ...(currentPkg.dependencies || {}),
            ...(currentPkg.devDependencies || {}),
          };
          addedDeps = Object.keys(after).filter((name) => !before[name]);
        }
      }

      if (addedDeps.length) {
        findings.push({
          severity: "Major",
          title: "新規 dependency 追加があります",
          detail: "必要性、利用箇所、dependency/devDependency の置き場所、サイズ影響を確認してください。",
          evidence: addedDeps.join(", "),
        });
      }

      if (lockChanged && !pkgChanged) {
        findings.push({
          severity: "Major",
          title: "lockfile のみ変更されています",
          detail: "package 定義変更なしの lockfile 差分は意図確認が必要です。",
          evidence: changedFiles.filter((file) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock)$/.test(file)).join(", "),
        });
      }
    }

    const docRequiredPatterns = compilePatterns(config.matchers.documentationRequired);
    const docsChanged = changedFiles.some((file) => isAnyMatch(file, compilePatterns(config.matchers.docsOnly)));
    if (
      docRequiredPatterns.length &&
      changedFiles.some((file) => docRequiredPatterns.some((pattern) => pattern.test(file))) &&
      !docsChanged
    ) {
      findings.push({
        severity: "Major",
        title: "変更内容に対するドキュメント更新が見当たりません",
        detail: "workflow、依存関係、またはコントラクト変更は手順や仕様の更新要否を確認すべきです。",
        evidence: unique(
          changedFiles.filter((file) => docRequiredPatterns.some((pattern) => pattern.test(file))),
        ).join(", "),
      });
    }

    const envExampleExclusions = compilePatterns(config.matchers.envFileExclusions);
    const envFileChanges = changedFiles.filter(
      (file) => /^\.env(\.|$)/.test(file) && !envExampleExclusions.some((pattern) => pattern.test(file)),
    );
    if (envFileChanges.length) {
      findings.push({
        severity: "Blocker",
        title: "環境依存ファイルが PR に含まれています",
        detail: "実行時シークレットやローカル環境ファイルはコミットすべきではありません。",
        evidence: envFileChanges.join(", "),
      });
    }

    const addedSecretEnv = addedLines.filter(
      ({ file, text }) =>
        !compilePatterns(config.matchers.envFileExclusions).some((pattern) => pattern.test(file)) &&
        SECRET_ENV_PATTERN.test(text),
    );
    if (addedSecretEnv.length) {
      findings.push({
        severity: "Blocker",
        title: "差分にシークレットらしき値が含まれています",
        detail: "コミットされた認証情報を削除し、repository secrets か環境変数管理へ移してください。",
        evidence: unique(addedSecretEnv.map(({ file }) => file)).join(", "),
      });
    }

    const addedCodeSecrets = addedLines.filter(
      ({ file, text }) =>
        !/\.md$/.test(file) &&
        !isHeuristicExcluded(file, config) &&
        !compilePatterns(config.matchers.envFileExclusions).some((pattern) => pattern.test(file)) &&
        CODE_SECRET_PATTERN.test(text),
    );
    if (addedCodeSecrets.length) {
      findings.push({
        severity: "Major",
        title: "ソースコードにシークレットらしき固定値が追加されています",
        detail: "識別子、token、app secret を設定経由ではなく直書きしていないか確認してください。",
        evidence: unique(addedCodeSecrets.map(({ file }) => file)).join(", "),
      });
    }

    const addedTodo = addedLines.filter(
      ({ file, text }) =>
        !/\.md$/.test(file) && !isHeuristicExcluded(file, config) && /\b(TODO|FIXME|XXX)\b/.test(text),
    );
    if (addedTodo.length) {
      findings.push({
        severity: "Minor",
        title: "未解決の TODO/FIXME が追加されています",
        detail: "追跡用 issue を明記するか、merge 前に解消してください。",
        evidence: unique(addedTodo.map(({ file }) => file)).join(", "),
      });
    }

    const addedConsole = addedLines.filter(
      ({ file, text }) =>
        !/\.md$/.test(file) && !isHeuristicExcluded(file, config) && DEBUG_LOG_PATTERN.test(text),
    );
    if (addedConsole.length) {
      findings.push({
        severity: "Minor",
        title: "デバッグログが差分に残っています",
        detail: "運用上必要なログでない限り `console.log` やファイル書き込みデバッグは削除してください。",
        evidence: unique(addedConsole.map(({ file }) => file)).join(", "),
      });
    }

    return { findings };
  }

  function buildReviewerFocus(activeStacks, config) {
    const focus = [];
    for (const [stackId, active] of Object.entries(activeStacks)) {
      if (!active) {
        continue;
      }
      const stack = config.stacks[stackId];
      if (stack?.reviewerFocus) {
        focus.push(stack.reviewerFocus);
      }
    }
    if (!focus.length) {
      focus.push("General: 仕様整合、回帰リスク、エラーハンドリング、保守性。");
    }
    return unique(focus);
  }

  return {
    rootDir,
    repoFiles,
    git,
    tryGit,
    relative,
    loadConfig,
    resolveScope,
    getChangedFiles,
    getDiffLines,
    getPackageJson,
    getActiveStacks,
    runProcessChecks,
    buildTestAdequacy,
    buildQualityGates,
    buildFindings,
    buildReviewerFocus,
  };
}

function resolveRepoRoot(args = {}, explicitRootDir) {
  return path.resolve(
    explicitRootDir || args["repo-root"] || process.env.PR_REVIEW_REPO_ROOT || process.cwd(),
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) {
      args._.push(current);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[current.slice(2)] = "true";
      continue;
    }
    args[current.slice(2)] = next;
    i += 1;
  }
  return args;
}

function walkDir(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agent") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results);
      continue;
    }
    results.push(fullPath);
  }
  return results;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("<!--")
  );
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function countByFile(entries, predicate) {
  return unique(entries.filter(predicate).map((entry) => entry.file));
}

function createCheck(id, title, status, evidence, details) {
  return { id, title, status, evidence, details };
}

function createAdequacyCheck(id, title, status, expected, actual, details) {
  return { id, title, status, expected, actual, details };
}

function createGate(id, title, status, evidence, details) {
  return { id, title, status, evidence, details };
}

function compilePatterns(patterns) {
  return (patterns || []).map((pattern) => new RegExp(pattern));
}

function compilePattern(pattern) {
  return pattern ? new RegExp(pattern) : null;
}

function readEvent(eventPath) {
  if (!eventPath || !fs.existsSync(eventPath)) {
    return null;
  }
  return readJson(eventPath);
}

function readContext(contextPath) {
  if (!contextPath || !fs.existsSync(contextPath)) {
    return null;
  }
  return readJson(contextPath);
}

function fetchPrContext(rootDir, prRef) {
  if (!prRef) {
    return null;
  }
  try {
    const output = execFileSync(
      "gh",
      [
        "pr",
        "view",
        String(prRef),
        "--json",
        "number,title,url,headRefName,baseRefName,headRefOid,files,statusCheckRollup",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function isAnyMatch(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function isHeuristicExcluded(file, config) {
  return isAnyMatch(file, compilePatterns(config.matchers.heuristicExclusions));
}

function getChangedTestFiles(changedFiles, testGroups) {
  const result = {};

  for (const [groupId, group] of Object.entries(testGroups)) {
    const include = compilePatterns(group.patterns);
    const exclude = compilePatterns(group.exclude);
    result[groupId] = changedFiles.filter(
      (file) =>
        include.some((pattern) => pattern.test(file)) &&
        !exclude.some((pattern) => pattern.test(file)),
    );
  }

  return result;
}

function formatChecks(checks) {
  return checks
    .map((check) => {
      const icon =
        check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "INFO";
      return `- ${check.title}: **${icon}**\n  根拠: \`${check.evidence}\`\n  補足: ${check.details}`;
    })
    .join("\n");
}

function formatAdequacyChecks(adequacyChecks) {
  return adequacyChecks
    .map((check) => {
      const icon =
        check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "NEEDS-INFO";
      return `- ${check.title}: **${icon}**\n  期待: ${check.expected}\n  実際: ${check.actual}\n  補足: ${check.details}`;
    })
    .join("\n");
}

function formatQualityGates(qualityGates) {
  return qualityGates
    .map((gate) => {
      const icon =
        gate.status === "pass" ? "PASS" : gate.status === "fail" ? "FAIL" : "NEEDS-INFO";
      return `- ${gate.title}: **${icon}**\n  根拠: \`${gate.evidence}\`\n  補足: ${gate.details}`;
    })
    .join("\n");
}

function formatFindings(findings) {
  if (!findings.length) {
    return "- 重大な懸念は検出されませんでした。必要に応じて手動レビューで仕様整合と回帰だけ確認してください。";
  }

  return findings
    .map(
      (finding) =>
        `- [${finding.severity}] ${finding.title}\n  理由: ${finding.detail}\n  根拠: \`${finding.evidence || "n/a"}\``,
    )
    .join("\n");
}

function buildMarkdown(scope, changedFiles, checks, adequacyChecks, qualityGates, findings, focus, config, activeStacks) {
  const scopeLine = scope.prNumber
    ? `PR #${scope.prNumber} (${scope.headRef} -> ${scope.baseRef})`
    : `${scope.headRef} -> ${scope.baseRef}`;
  const changedSummary = changedFiles.length
    ? changedFiles.slice(0, 12).map((file) => `\`${file}\``).join(", ")
    : "変更ファイルは検出されませんでした。";
  const activeStackList = Object.entries(activeStacks)
    .filter(([, active]) => active)
    .map(([stackId]) => `\`${stackId}\``)
    .join(", ");

  return `${config.botMarker}
## 自動 PR レビュー

- 対象: ${scopeLine}
- タイトル: ${scope.prTitle || "n/a"}
- URL: ${scope.prUrl || "n/a"}
- package.json: \`${config.packageJsonPath}\`
- 有効スタック: ${activeStackList || "該当なし"}
- 変更ファイル数 (${changedFiles.length}): ${changedSummary}

### プロセスチェック
${formatChecks(checks)}

### テスト妥当性
${formatAdequacyChecks(adequacyChecks)}

### 品質ゲート状況
${formatQualityGates(qualityGates)}

### 指摘事項
${formatFindings(findings)}

### レビュワー注視点
${focus.map((item) => `- ${item}`).join("\n")}
`;
}

function normalizeRuleFinding(finding, reviewer = "rule-reviewer") {
  return {
    reviewer,
    severity: finding.severity || "Question",
    title: finding.title,
    detail: finding.detail,
    evidence: finding.evidence || "n/a",
    category: "deterministic",
    confidence: 0.95,
  };
}

function runRuleReview(options = {}) {
  const args = options.args || {};
  const rootDir = resolveRepoRoot(args, options.rootDir);
  const runtime = createRuntime(rootDir);
  const event = options.event || readEvent(args["event-path"] || process.env.GITHUB_EVENT_PATH);
  const context =
    options.context ||
    readContext(args["context-path"] || process.env.PR_CONTEXT_PATH) ||
    fetchPrContext(rootDir, args.pr || process.env.PR_NUMBER);
  const config = options.config || runtime.loadConfig(args.config || process.env.PR_REVIEW_CONFIG);
  const scope = runtime.resolveScope(event, context, args);
  const changedFiles = runtime.getChangedFiles(scope, context);
  const addedLines = runtime.getDiffLines(scope, "+");
  const pkg = runtime.getPackageJson(config);
  const activeStacks = runtime.getActiveStacks(changedFiles, config);
  const checks = runtime.runProcessChecks(scope, pkg, config);
  const { adequacyChecks } = runtime.buildTestAdequacy(changedFiles, config, activeStacks);
  const qualityGates = runtime.buildQualityGates(context, pkg, config);
  const { findings } = runtime.buildFindings(
    scope,
    changedFiles,
    addedLines,
    checks,
    adequacyChecks,
    qualityGates,
    activeStacks,
    config,
  );
  const focus = runtime.buildReviewerFocus(activeStacks, config);
  const markdown = buildMarkdown(
    scope,
    changedFiles,
    checks,
    adequacyChecks,
    qualityGates,
    findings,
    focus,
    config,
    activeStacks,
  );
  const blockers = findings.filter((finding) => finding.severity === "Blocker").length;
  return {
    reviewer: "rule-reviewer",
    scope,
    config,
    changedFiles,
    checks,
    adequacyChecks,
    qualityGates,
    findings,
    normalizedFindings: findings.map((finding) => normalizeRuleFinding(finding)),
    focus,
    markdown,
    blockers,
    summary: `Checks: ${checks.length}, Findings: ${findings.length}, Blockers: ${blockers}`,
  };
}

function writeOutput(outputPath, markdown) {
  if (!outputPath) {
    process.stdout.write(markdown);
    return;
  }
  fs.writeFileSync(outputPath, markdown);
}

module.exports = {
  DEFAULT_BOT_MARKER,
  parseArgs,
  resolveRepoRoot,
  readEvent,
  readContext,
  createRuntime,
  runRuleReview,
  writeOutput,
  buildMarkdown,
  normalizeRuleFinding,
};
