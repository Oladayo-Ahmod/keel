import { createTrozu, type Trozu } from "@trozu/sdk";
import { createPublicClient, getAddress, http, isAddress, type PublicClient } from "viem";
import { collectAlerts, type Alert } from "./check.js";
import { resolve } from "node:path";
import { DEFAULT_STATE_FILE, isCoolingDown, loadState, saveState } from "./state.js";
import { buildPayload, hostOf, post, urlProblem, type PostOptions, type WebhookFormat } from "./webhook.js";

export interface Config {
  rpcUrl?: string;
  tokenIds: bigint[];
  holders: string[];
  marginPoints: number;
  lookbackBlocks: bigint;
  cooldownSeconds: number;
  stateFile?: string;
  webhookUrl?: string;
  format: WebhookFormat;
  dryRun: boolean;
}

export class ConfigError extends Error {}

const num = (name: string, v: string | undefined, dflt: number, min: number, max: number) => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} has to be a number from ${min} to ${max}`);
  return n;
};

/** Settings come from the environment (the webhook URL is a secret, so never from a flag) plus `--dry-run`. */
export function parseConfig(env: Record<string, string | undefined>, argv: string[], cwd = process.cwd()): Config {
  const tokenIds = (env.TOKEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/^\d{1,20}$/.test(s)) throw new ConfigError("TOKEN_IDS has to be a comma separated list of whole numbers");
      return BigInt(s);
    });
  const holders = (env.HOLDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!isAddress(s, { strict: false })) throw new ConfigError("HOLDERS has to be a comma separated list of addresses");
      return getAddress(s);
    });
  if (tokenIds.length === 0 && holders.length === 0) throw new ConfigError("set TOKEN_IDS or HOLDERS, so there is something to watch");

  const format = (env.WEBHOOK_FORMAT ?? "auto") as WebhookFormat;
  if (!["auto", "slack", "discord", "json"].includes(format)) throw new ConfigError("WEBHOOK_FORMAT has to be auto, slack, discord or json");

  const dryRun = argv.includes("--dry-run") || env.DRY_RUN === "1";
  const webhookUrl = env.WEBHOOK_URL?.trim() || undefined;
  if (!dryRun && !webhookUrl) throw new ConfigError("set WEBHOOK_URL (or run with --dry-run)");
  if (webhookUrl) {
    const problem = urlProblem(webhookUrl);
    if (problem) throw new ConfigError(problem);
  }

  return {
    rpcUrl: env.TROZU_RPC_URL || undefined,
    tokenIds,
    holders,
    marginPoints: num("MARGIN_POINTS", env.MARGIN_POINTS, 10, 0, 500),
    lookbackBlocks: BigInt(num("LOOKBACK_BLOCKS", env.LOOKBACK_BLOCKS, 3_000, 1, 200_000)),
    cooldownSeconds: num("COOLDOWN_MINUTES", env.COOLDOWN_MINUTES, 360, 0, 10_080) * 60,
    // on by default, so scheduled runs do not repeat themselves; STATE_FILE=none turns it off
    stateFile: env.STATE_FILE === "none" ? undefined : resolve(cwd, env.STATE_FILE || DEFAULT_STATE_FILE),
    webhookUrl,
    format,
    dryRun,
  };
}

export interface Deps {
  env: Record<string, string | undefined>;
  argv: string[];
  out: (line: string) => void;
  err: (line: string) => void;
  /** Tests inject a chain; the default is the public Mezo RPC. */
  makeChain?: (cfg: Config) => { trozu: Trozu; client: PublicClient };
  post?: PostOptions;
  now?: () => number;
  /** Where a relative STATE_FILE (and the default) is resolved. Default: the process's working directory. */
  cwd?: string;
}

function defaultChain(cfg: Config) {
  const client = (cfg.rpcUrl ? createPublicClient({ transport: http(cfg.rpcUrl, { retryCount: 3, timeout: 20_000 }) }) : undefined) as PublicClient | undefined;
  const base = createTrozu({ client });
  return { trozu: base, client: client ?? (createPublicClient({ transport: http(base.deployment.rpcUrl, { retryCount: 3, timeout: 20_000 }) }) as PublicClient) };
}

/**
 * One pass: read the positions, work out the alerts, send (or print) them. Returns the process exit code:
 * 0 done (including "nothing to report"), 1 a read or the webhook failed, 2 the settings are wrong.
 */
export async function run(d: Deps): Promise<number> {
  let cfg: Config;
  try {
    cfg = parseConfig(d.env, d.argv, d.cwd);
  } catch (e) {
    d.err(`config: ${(e as Error).message}`);
    return 2;
  }

  try {
    const { trozu, client } = (d.makeChain ?? defaultChain)(cfg);
    const ids = new Set(cfg.tokenIds);
    for (const h of cfg.holders) for (const id of await trozu.lens.positionsOf(h)) ids.add(id);

    const state = loadState(cfg.stateFile);
    const latest = await client.getBlockNumber();
    const from = state.lastBlock ? BigInt(state.lastBlock) + 1n : latest - cfg.lookbackBlocks + 1n;
    const found = from > latest ? [] : await collectAlerts({ trozu, client, tokenIds: [...ids], marginPoints: cfg.marginPoints, fromBlock: from > 0n ? from : 0n, toBlock: latest });

    const now = Math.floor((d.now?.() ?? Date.now()) / 1000);
    const alerts: Alert[] = found.filter((a) => !isCoolingDown(state, a.key, now, cfg.cooldownSeconds));
    d.err(`watching ${ids.size} position(s), blocks ${from}..${latest}, ${found.length} alert(s), ${alerts.length} after cooldown`);

    if (alerts.length > 0) {
      const payload = buildPayload(alerts, cfg.format, cfg.webhookUrl);
      if (cfg.dryRun) {
        d.out(`dry run: would post ${alerts.length} alert(s)${cfg.webhookUrl ? ` to ${hostOf(cfg.webhookUrl)}` : ""}`);
        d.out(JSON.stringify(payload, null, 2));
        // a dry run changes nothing, including the state file
        return 0;
      }
      await post(cfg.webhookUrl!, payload, d.post);
      for (const a of alerts) state.sent[a.key] = now;
      d.out(`posted ${alerts.length} alert(s) to ${hostOf(cfg.webhookUrl!)}`);
    } else {
      d.out("no alerts");
    }

    if (!cfg.dryRun) {
      state.lastBlock = latest.toString();
      saveState(cfg.stateFile, state);
    }
    return 0;
  } catch (e) {
    // the message is ours or the SDK's; the webhook URL is never in either
    d.err(`failed: ${(e as Error).message.split("\n")[0]?.slice(0, 200)}`);
    return 1;
  }
}
