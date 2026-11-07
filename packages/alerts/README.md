# @trozu/alerts

A small script that watches guarded Trozu positions and posts to a webhook when

- a position is within a margin of its guardian floor (or under it), or
- the guardian (keeper) acted on it.

It only reads the chain. **No key is needed or read.** The webhook URL is the only secret, and it comes from
an environment variable, never from a flag or a file in the repo.

## Run it

```sh
cd packages && npm install && npm run build
TOKEN_IDS=1,2 WEBHOOK_URL=https://hooks.slack.com/services/... node alerts/dist/cli.js
```

Try it first with `--dry-run`: it prints the alerts it would send and the host it would send them to, posts
nothing and does not touch the state file. No `WEBHOOK_URL` is needed for a dry run.

| Variable | Meaning | Default |
|---|---|---|
| `TOKEN_IDS` | Position ids to watch, comma separated | |
| `HOLDERS` | Wallet addresses; every position they hold is watched | |
| `WEBHOOK_URL` | Where to POST. Must be https. **Keep it a secret** | |
| `WEBHOOK_FORMAT` | `slack`, `discord`, `json` or `auto` (chosen by host) | `auto` |
| `MARGIN_POINTS` | Alert when the ratio is within this many percentage points of the floor, or under it | `10` |
| `STATE_FILE` | A JSON file that remembers the last block read and when each alert was sent | none |
| `COOLDOWN_MINUTES` | With a state file, do not repeat a near-floor alert inside this time | `360` |
| `LOOKBACK_BLOCKS` | How far back to look for keeper actions when there is no state yet | `3000` |
| `TROZU_RPC_URL` | RPC endpoint | the public Mezo testnet RPC |

At least one of `TOKEN_IDS` and `HOLDERS` is needed. Exit codes: `0` done (including "nothing to report"), `1`
a read or the webhook failed, `2` the settings are wrong.

A position with no live guardian policy is not guarded, so it never alerts: there is no floor to be near.
Alerts are written from numbers only (ratio, floor, reserve, amounts, block). Nothing a stranger wrote on
chain is put in them.

**With no state file** every run looks at the last `LOOKBACK_BLOCKS` blocks for keeper actions and reports
a near-floor position every time it runs, so overlapping runs repeat themselves. Use `STATE_FILE` for anything
scheduled.

The webhook URL is never printed: logs and errors name only its host.

## GitHub Actions

[`github-workflow.example.yml`](github-workflow.example.yml) is a job that runs every 15 minutes, with the
webhook in a repository secret (`ALERT_WEBHOOK_URL`), the ids in a variable (`ALERT_TOKEN_IDS`) and the state
file kept between runs with the Actions cache. Copy it to `.github/workflows/` to use it; it is not enabled
here. It has a manual run with a dry-run switch.

## Tests

`npm test` runs 41 tests: the alert rules (margins, boundaries, no policy, no price, no debt, keeper actions,
log windows), payload shapes per service, posting (retry on 5xx, 429 and network errors, no retry on 4xx,
timeout, https only, the URL never in an error), config parsing, dry run, state and cooldown.
They run against a mock chain and a stubbed `fetch`.
