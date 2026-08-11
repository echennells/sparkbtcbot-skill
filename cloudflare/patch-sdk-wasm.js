// Replaces the Spark SDK browser build's base64-inlined wasm blobs with
// static .wasm imports. On Cloudflare Workers this is required, not just a
// size win: WebAssembly.instantiate(bytes) is forbidden dynamic codegen,
// while an imported .wasm arrives as a precompiled WebAssembly.Module that
// the wasm-bindgen glue accepts via `module_or_path`.
const fs = require("fs");
const path = require("path");

const entry = path.join(
  __dirname,
  "node_modules/@buildonspark/spark-sdk/dist/index.browser.js",
);
let src = fs.readFileSync(entry, "utf8");

if (src.includes("PATCHED-WASM-IMPORTS")) {
  console.log("already patched");
  process.exit(0);
}

const replacements = [
  {
    decl: /var wasm_browser_bg_default\$1 = __toBinaryNode\("[A-Za-z0-9+/=]+"\);?/,
    imp: `/* PATCHED-WASM-IMPORTS */ import wasm_browser_bg_default$1 from "../src/spark-bindings/wasm/wasm-browser-bg.wasm";`,
  },
  {
    decl: /var wasm_browser_bg_default = __toBinaryNode\("[A-Za-z0-9+/=]+"\);?/,
    // --no-tokens: BTKN/LRC20 ops will throw on first use; everything else
    // (init, balance, transfers, invoices, deposits) never touches this module.
    imp: process.argv.includes("--no-tokens")
      ? `var wasm_browser_bg_default = void 0;`
      : `import wasm_browser_bg_default from "../src/token-primitives-bindings/wasm/wasm-browser-bg.wasm";`,
  },
];

for (const { decl, imp } of replacements) {
  if (!decl.test(src)) {
    console.error("pattern not found:", decl);
    process.exit(1);
  }
  src = src.replace(decl, imp);
}

fs.writeFileSync(entry, src);
console.log(
  "patched:",
  entry,
  "->",
  (fs.statSync(entry).size / 1048576).toFixed(1),
  "MiB (was ~5.9 MiB)",
);
