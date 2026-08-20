#!/usr/bin/env node
// This is the NAME-RESERVATION STUB, not the real CLI. If this ran, npx fell
// back to the registry because no local `sparkbtcbot` bin was found — which
// means the caller is in the wrong directory or hasn't installed the real
// package. Refuse loudly and say what to do; never touch wallets or seeds.
process.stderr.write(
  "sparkbtcbot: you've reached the npm name-reservation stub, not the real CLI.\n" +
  "\n" +
  "npx fell back to the registry because no locally installed `sparkbtcbot`\n" +
  "command was found here. The real package is `sparkbtcbot-skill`. Fix:\n" +
  "\n" +
  "  cd <the project that uses the wallet>\n" +
  "  npm install sparkbtcbot-skill\n" +
  "  npm exec --no -- sparkbtcbot <command>\n" +
  "\n" +
  "This stub exists so a wrong-directory invocation lands on code owned by the\n" +
  "sparkbtcbot project instead of a squatter's. It does nothing else.\n" +
  "https://github.com/echennells/sparkbtcbot\n",
);
process.exit(1);
