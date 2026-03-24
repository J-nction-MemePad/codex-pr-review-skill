"use strict";

const STACK_MODULES = {
  "nextjs-app": {
    title: "Next.js App",
    changeMatchers: [
      "^app/(?!api/).+",
      "^components/",
      "^app/globals\\.css$",
    ],
    reviewerFocus:
      "Next.js UI: server/client boundary、hydration、loading/error state、responsive behavior、accessibility。",
    adequacy: {
      id: "nextjs-app",
      title: "Next.js UI 変更に対するテスト更新",
      expected: "E2E または UI integration test の追加または更新",
      testGroups: ["playwright-e2e", "vitest-ui"],
      details:
        "画面遷移、主要操作、表示状態の変化がある場合は受け入れ観点を担保するテスト更新を期待します。",
      missingStatus: "fail",
    },
  },
  "nextjs-routes": {
    title: "Next.js Route Handlers",
    changeMatchers: ["^app/api/", "^app/auth/", "^lib/.*auth", "^middleware\\.(ts|js)$"],
    reviewerFocus:
      "Next.js Route Handlers: input validation、session/JWT、RBAC、response code、unsafe default、cache behavior。",
    adequacy: {
      id: "nextjs-routes",
      title: "Route Handler / 認証変更に対する検証更新",
      expected: "E2E、DB/integration test、または同等の API 検証更新",
      testGroups: ["playwright-e2e", "db-tests", "integration-tests", "vitest-api"],
      details:
        "API、認証、server action 相当の変更には実フローまたはデータアクセスの検証更新が必要です。",
      missingStatus: "fail",
    },
  },
  vite: {
    title: "Vite",
    changeMatchers: ["^src/", "^public/", "^vite\\.config\\.(ts|js|mjs|cjs)$", "^index\\.html$"],
    reviewerFocus:
      "Vite: bundle entry、env exposure、routing fallback、asset loading、build output stability。",
    adequacy: {
      id: "vite",
      title: "Vite フロントエンド変更に対するテスト更新",
      expected: "E2E、component test、または Vitest UI test の更新",
      testGroups: ["playwright-e2e", "vitest-ui"],
      details:
        "画面や主要操作に影響する変更は、UI の受け入れ観点をカバーするテスト更新を期待します。",
      missingStatus: "fail",
    },
  },
  playwright: {
    title: "Playwright",
    changeMatchers: ["^e2e/", "^playwright\\.config\\.(ts|js|mjs|cjs)$"],
    reviewerFocus:
      "Playwright: major user flows、empty/error state、selector stability、flake risk、environment assumptions。",
  },
  vitest: {
    title: "Vitest",
    changeMatchers: ["^vitest\\.config\\.(ts|js|mjs|cjs)$", "^src/.*\\.(spec|test)\\.(ts|tsx|js)$"],
    reviewerFocus:
      "Vitest: test isolation、mock quality、assertion strength、environment setup drift。",
  },
  supabase: {
    title: "Supabase",
    changeMatchers: ["^supabase/", "^lib/supabase/", "^app/api/.*supabase", "^test/db/"],
    reviewerFocus:
      "Supabase: migration safety、schema defaults、RLS/permission assumptions、data consistency、rollback path。",
    adequacy: {
      id: "supabase",
      title: "Supabase / DB 変更に対する検証更新",
      expected: "DB integration/E2E の追加または更新",
      testGroups: ["db-tests"],
      details:
        "migration 追加だけでは不十分です。読み書きや制約を確認する DB 側の検証更新を期待します。",
      missingStatus: "fail",
    },
  },
  hardhat: {
    title: "Hardhat",
    changeMatchers: ["^hardhat\\.config\\.(ts|js)$", "^scripts/deploy\\.(ts|js)$", "^ignition/"],
    reviewerFocus:
      "Hardhat: network config、deploy safety、script idempotency、environment assumptions。",
  },
  foundry: {
    title: "Foundry",
    changeMatchers: ["^contracts/foundry\\.toml$", "^contracts/script/", "^contracts/lib/"],
    reviewerFocus:
      "Foundry: forge profile、remappings、deployment safety、script idempotency、RPC/env assumptions。",
  },
  solidity: {
    title: "Solidity",
    changeMatchers: ["^contracts/", "^typechain-types/"],
    reviewerFocus:
      "Solidity: access control、event emission、boundary conditions、underfunded path、asset safety。",
    adequacy: {
      id: "solidity",
      title: "Solidity 変更に対するテスト更新",
      expected: "contract test の追加または更新",
      testGroups: ["contract-tests"],
      details:
        "コントラクト変更には直接対応する test 更新と、coverage gate を満たす検証が必要です。",
      missingStatus: "fail",
    },
  },
  "github-actions": {
    title: "GitHub Actions",
    changeMatchers: ["^\\.github/workflows/", "^\\.husky/", "^scripts/", "^eslint\\.config\\.mjs$", "^package\\.json$"],
    reviewerFocus:
      "Automation: trigger scope、permissions、failure propagation、comment idempotency、developer workflow impact。",
    adequacy: {
      id: "github-actions",
      title: "workflow / automation 変更に対する検証更新",
      expected: "必要なら関連する dry-run、self-check、または運用手順更新",
      testGroups: [],
      details: "workflow や hook のみの変更は、自動で必須テストを断定しません。",
      missingStatus: "needs-info",
    },
  },
  dependencies: {
    title: "Dependencies",
    changeMatchers: ["^package\\.json$", "(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$"],
    reviewerFocus:
      "Dependencies: necessity、package placement、version drift、bundle/runtime impact、upgrade risk。",
  },
};

const DEFAULT_TEST_GROUPS = {
  "playwright-e2e": {
    patterns: ["(^|/)e2e/.*\\.(spec|test)\\.(ts|tsx|js)$"],
  },
  "vitest-ui": {
    patterns: ["(^|/)src/.*\\.(spec|test)\\.(ts|tsx)$", "(^|/)components/.*\\.(spec|test)\\.(ts|tsx)$"],
  },
  "vitest-api": {
    patterns: ["(^|/)src/.*\\.(spec|test)\\.(ts|tsx)$", "(^|/)app/api/.*\\.(spec|test)\\.(ts|js)$"],
  },
  "db-tests": {
    patterns: ["^test/db/.*\\.(js|ts)$"],
  },
  "integration-tests": {
    patterns: ["(^|/)(test|tests|integration)/.*\\.(spec|test)\\.(ts|tsx|js)$"],
  },
  "contract-tests": {
    patterns: ["^test/.*\\.(js|ts|sol)$"],
    exclude: ["^test/db/"],
  },
  any: {
    patterns: ["(^|/)(test|e2e|tests|integration)/", "\\.(spec|test)\\.(ts|tsx|js|sol)$"],
  },
};

module.exports = {
  STACK_MODULES,
  DEFAULT_TEST_GROUPS,
};
