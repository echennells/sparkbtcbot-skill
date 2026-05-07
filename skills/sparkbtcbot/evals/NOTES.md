# Eval status — paused

Picking back up later. Files are committed; nothing is running.

## What's here

- `trigger-eval.json` — 10 should-trigger + 10 should-not-trigger queries for description-triggering benchmarks. **Rewritten** from the original set (which had vague queries like "build a tipping bot" that Claude answered without consulting the skill). Current set requires real Spark knowledge on positives (SDK errors, `IssuerSparkWallet.createToken`, `claimStaticDeposit`, BTKN balance fields, cooperative exit fees, etc.) and uses adjacent-stack queries on negatives (NWC, Strike, Alby, breez-sdk, lightspark wallet-sdk, tetherto/wdk-wallet-spark, BDK, Voltage Cloud, OpenNode, Cashu, LNbits).
- `evals.json` — 6 output evals with expectations encoding the SDK contracts the skill teaches (deprecated `balance` vs `satsBalance.available`, `info.ownedBalance` not `info.balance`, `validateMessageWithIdentityKey` 2-arg not 3-arg). Untouched in this round.

## What happened last time (don't repeat)

- Ran the **optimizer** (`run_loop.py --max-iterations 3 --runs-per-query 3`) plus **4 more standalone `run_eval.py` passes**, all with `--model claude-opus-4-7`. Total ~420 `claude -p` invocations, each spawning a full Claude Code session (~13K tokens of system context per call, 2-3 internal Opus calls per invocation). **Estimated cost: $120-180.** Way too much for a triggering benchmark.
- Got 10/20 on the original eval set. The 10 should-not-trigger queries all passed cleanly. The 10 should-trigger queries all failed — but the failures were because **the queries were too generic** (Claude answered them with general Lightning knowledge without consulting any skill), not because the description was bad. Fixing the queries was the right move.

## When picking up — the cheap, focused command

Skip the optimizer. One pass, one run per query (or three for variance), no re-runs.

```bash
cd /workspace/temp/anthropics-skills/skills/skill-creator
python3 -m scripts.run_eval \
  --eval-set /workspace/skills/sparkbtcbot/evals/trigger-eval.json \
  --skill-path /workspace/skills/sparkbtcbot \
  --model claude-opus-4-7 \
  --runs-per-query 3 \
  --num-workers 5 \
  > /tmp/eval-v2.json 2> /tmp/eval-v2.err
```

Cost expectation: ~60 invocations × ~$0.20 each ≈ **$12 for one Opus pass at runs/query=3**, or ~$4 at runs/query=1.

Before running:
1. **Clean leftover slash commands**: `rm -f /workspace/.claude/commands/sparkbtcbot-skill-*.md` — the harness creates a unique slash command per query and only cleans up on success. Stale ones from interrupted runs confuse Claude (sees N near-duplicate slash commands and may pick the wrong one or none).
2. **Make sure `cd` lands in `skill-creator/`** — `python3 -m scripts.run_eval` resolves the module via cwd. Wrong cwd = empty output, silent failure.
3. **Make sure no other `python3 -m scripts.run_eval` or `claude -p` subprocesses are running** from a previous interrupted attempt: `pgrep -af "scripts.run_eval|claude -p"`.

## Things to decide before running

- **Model**: stay on Opus (matches deployment) vs use Haiku (~10× cheaper, but trigger behavior differs from Opus — smaller models trigger more eagerly).
- **runs/query**: 1 (cheap, no variance estimate) vs 3 (better signal, 3× cost).
- **Whether to also run `evals.json` output evals** — that's a different harness (`scripts.run_loop` on `evals.json` doesn't apply; output evals are run via subagents per the skill-creator workflow). We never tried these.

## Result-parsing one-liner

```python
python3 -c "
import json
d = json.load(open('/tmp/eval-v2.json'))
print('Pass:', d['summary']['passed'], '/', d['summary']['total'])
for r in d['results']:
    if not r['pass']:
        kind = 'UNDER' if r['should_trigger'] else 'OVER '
        print(f'  [{kind}] rate={r[\"trigger_rate\"]:.2f}  {r[\"query\"][:100]}')
"
```

## Pending question if results are still bad

If we run this and still get most should-trigger queries failing, the issue is structural to how the harness tests skills (it creates a project-level slash command and checks for `Skill`/`Read` tool calls in `claude -p` output) — not a description problem. At that point the right move is probably to skip trigger evals entirely and rely on output evals (`evals.json`) instead, since those test what the skill *produces* given the skill is loaded, which is the failure mode that actually matters.
