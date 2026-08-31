// First command in every test script (`node tests/check-dev-deps.js && vitest
// ...` — inline because npm 10.9.8 verifiably does NOT run pre-hooks for
// colon-named scripts like pretest:unit). A pruned install
// (npm prune --omit=dev) keeps the wallet fully functional but removes
// vitest, and the raw failure that follows says nothing about the cause:
// "sh: 1: vitest: not found" — or worse, npm's exec fallback silently
// fetching an unpinned vitest from the registry onto the machine holding
// the seed, which is exactly the silent-registry-fetch class SECURITY.md
// exists to prevent. The natural "fixes" (npm install vitest, or a plain
// npm install with scripts enabled) are the forbidden commands. So fail
// FIRST, with the doctrine-compliant remedy in the error text.
//
// Not a vitest test file (doesn't match tests/**/*.test.js), so the suite
// never picks it up; it exists only to be run by the pretest hooks.
import { existsSync } from "node:fs";

if (!existsSync(new URL("../node_modules/.bin/vitest", import.meta.url))) {
  console.error(`
Tests need DEV dependencies, and this install has them pruned (vitest is missing).
The wallet itself is fine — a pruned install runs everything except the test suite.

To run tests, reinstall dev dependencies WITHOUT --omit=dev, keeping install
scripts off per this repo's supply-chain rule (SECURITY.md):

  npm install --ignore-scripts

Do NOT install vitest ad hoc, and do NOT rerun npm install without --ignore-scripts.
`);
  process.exit(1);
}
