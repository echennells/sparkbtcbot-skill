#!/usr/bin/env node
// NAME-RESERVATION STUB for the RETIRED `sparkbtcbot-setup` command.
//
// `sparkbtcbot-setup` was a bin in sparkbtcbot-skill 0.4.x-0.5.x. 0.6.0 collapsed the five
// per-command bins into one dispatcher, so the command is now `sparkbtcbot setup`.
// The old name stays registered because `npx <cmd>` resolves the string you type as a
// package name: an agent or user recalling the old form would otherwise land on
// whatever a squatter published there — and with no TTY, npx installs and runs it
// silently. Refuse loudly; never touch wallets or seeds.
process.stderr.write(
  "sparkbtcbot-setup: this command was retired in sparkbtcbot-skill 0.6.0.\n" +
  "\n" +
  "You have reached a name-reservation stub, not a wallet tool. Use:\n" +
  "\n" +
  "  cd <the project that uses the wallet>\n" +
  "  npm install --ignore-scripts sparkbtcbot-skill\n" +
  "  npm exec --no -- sparkbtcbot setup\n" +
  "\n" +
  "This stub does nothing else.\n" +
  "https://github.com/echennells/sparkbtcbot\n",
);
process.exit(1);
