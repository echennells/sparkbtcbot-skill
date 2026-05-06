import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "../../node_modules/@buildonspark/spark-sdk/dist");

function readSdkTypeDeclarations() {
  // The bundle file gets a content-hashed name (e.g. types-CPXB2AOW.d.ts) that
  // changes when the SDK is republished. Concatenate every .d.ts in dist/ so
  // we don't have to know the exact filename.
  return readdirSync(distDir)
    .filter((f) => f.endsWith(".d.ts"))
    .map((f) => readFileSync(join(distDir, f), "utf8"))
    .join("\n");
}

describe("getBalance() return shape", () => {
  // Regression test: in 0.7.x, the per-token field renamed from `balance` to
  // `ownedBalance` / `availableToSendBalance`. Examples and SKILL.md were
  // updated to use `ownedBalance`. If the SDK renames it again or drops the
  // field, this test fails before the examples ever run.
  const declarations = readSdkTypeDeclarations();

  it("TokenBalanceMap entries expose ownedBalance and availableToSendBalance", () => {
    const match = declarations.match(/type TokenBalanceMap = Map<[^>]+,\s*\{([^}]+)\}>/);
    expect(match, "TokenBalanceMap type definition not found in SDK").not.toBeNull();
    const body = match[1];
    expect(body).toMatch(/ownedBalance:\s*bigint/);
    expect(body).toMatch(/availableToSendBalance:\s*bigint/);
    expect(body).toMatch(/tokenMetadata:/);
  });

  it("getBalance() declares satsBalance with available/owned/incoming", () => {
    expect(declarations).toMatch(/satsBalance:\s*\{[^}]*available:\s*bigint/);
    expect(declarations).toMatch(/satsBalance:\s*\{[^}]*owned:\s*bigint/);
    expect(declarations).toMatch(/satsBalance:\s*\{[^}]*incoming:\s*bigint/);
  });
});
