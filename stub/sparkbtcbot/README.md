# sparkbtcbot (name-reservation stub)

**The real package is [`sparkbtcbot-skill`](https://www.npmjs.com/package/sparkbtcbot-skill).**

This package exists for one reason: `sparkbtcbot-skill`'s CLI bin is named
`sparkbtcbot`, and `npx` falls back to fetching a registry package by that name
when no local bin is found (wrong directory, package not installed). Before this
stub existed, that fallback name was unregistered — anyone could have claimed it
and had their code run at wallet-bootstrap time. Now the fallback lands here: a
program that prints where you went wrong and exits 1. It never touches wallets,
seeds, or the network.

```bash
# what you actually want:
npm install sparkbtcbot-skill
npm exec --no -- sparkbtcbot <command>
```

## Publishing (maintainers)

This stub is published manually and should almost never change:

```bash
cd stub/sparkbtcbot
npm publish --access public
```

(First publish requires `npm login`. It is deliberately NOT wired into the
repo's tag-triggered publish workflow — its version is independent of
`sparkbtcbot-skill` and churn here would only add noise.)
