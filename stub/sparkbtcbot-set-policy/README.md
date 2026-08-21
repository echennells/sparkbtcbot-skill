# sparkbtcbot-set-policy

**This is not a wallet tool.** It is a name-reservation stub owned by the
[sparkbtcbot](https://github.com/echennells/sparkbtcbot) project.

`sparkbtcbot-set-policy` was a command in `sparkbtcbot-skill` 0.4.x-0.5.x. Version 0.6.0 replaced the five
per-command bins with a single dispatcher, so the command is now:

```bash
npm install --ignore-scripts sparkbtcbot-skill
npm exec --no -- sparkbtcbot set-policy
```

## Why this package exists

`npx <cmd>` resolves whatever you type as an npm package name. If `sparkbtcbot-set-policy` were
unregistered, a bare `npx sparkbtcbot-set-policy` — typed from memory, an old tutorial, or by an AI agent
working from stale training data — would fetch and execute whatever someone else published
under that name. npx only prompts on an interactive terminal; with no TTY it installs and
runs silently. Since that happens at wallet-bootstrap time, the project keeps the retired
names registered. This package prints an error and exits 1.
