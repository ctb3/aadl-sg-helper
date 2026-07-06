import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { config } from "../config";

/**
 * Runtime feature flags via AWS AppConfig (a feature-flags profile), read with
 * the appconfigdata polling API.
 *
 * One StartConfigurationSession per process; GetLatestConfiguration is polled
 * at most once per `flagCacheTtlMs` and returns *empty* content when nothing
 * changed — so we keep the last-known values between changes. A flip in the
 * AppConfig console/CLI therefore propagates within ~one TTL, no redeploy.
 *
 * Fail-open by design: if AppConfig isn't configured (local dev — empty
 * `appconfigEnv`), unreachable, or the flag is absent from the profile, we fall
 * back to the env default. A flag read never blocks or crashes the request.
 *
 * Feature-flag JSON shape (AWS.AppConfig.FeatureFlags):
 *   { "<flag>": { "enabled": boolean, ...attributes } }
 */

const client = new AppConfigDataClient({ region: config.awsRegion });

let token: string | undefined; // rotating poll token (per process)
let cached: Record<string, { enabled?: boolean; [attr: string]: unknown } | undefined> = {};
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

const configured = (): boolean => config.appconfigEnv !== "";

async function poll(): Promise<void> {
  if (!token) {
    const s = await client.send(
      new StartConfigurationSessionCommand({
        ApplicationIdentifier: config.appconfigApp,
        EnvironmentIdentifier: config.appconfigEnv,
        ConfigurationProfileIdentifier: config.appconfigProfile,
        // AppConfig's floor is 15s; align the server-side poll with our TTL.
        RequiredMinimumPollIntervalInSeconds: Math.max(15, Math.floor(config.flagCacheTtlMs / 1000)),
      }),
    );
    token = s.InitialConfigurationToken;
  }
  const r = await client.send(new GetLatestConfigurationCommand({ ConfigurationToken: token }));
  token = r.NextPollConfigurationToken ?? token;
  // Empty on an unchanged poll — keep the previous values in that case.
  if (r.Configuration && r.Configuration.length) {
    cached = JSON.parse(Buffer.from(r.Configuration).toString("utf8"));
  }
}

async function refresh(): Promise<void> {
  if (Date.now() - fetchedAt < config.flagCacheTtlMs) return;
  if (inflight) return inflight; // collapse concurrent refreshes
  inflight = (async () => {
    try {
      await poll();
    } catch (err) {
      // Keep last-known values and drop the session token so the next refresh
      // re-establishes it (handles an expired session/token cleanly).
      token = undefined;
      console.warn("AppConfig poll failed:", (err as Error)?.message ?? err);
    } finally {
      fetchedAt = Date.now(); // back off one TTL on success or failure
      inflight = null;
    }
  })();
  return inflight;
}

/** Stale-while-revalidate: once primed, serve last-known values immediately
 * and let the TTL-expired poll run in the background — an expired TTL must
 * never add an AppConfig round-trip to a user's extract. Only the process's
 * first read (nothing cached yet) blocks. */
async function ensureFresh(): Promise<void> {
  if (fetchedAt === 0) return refresh();
  void refresh();
}

const envBool = (v: string): boolean => !["off", "false", "0", "no"].includes(v.trim().toLowerCase());

/**
 * Generic boolean flag read. Uses the AppConfig value when present; otherwise
 * (unconfigured / unreachable / flag missing) falls back to `envDefault`.
 * Adding a second flag is a one-liner: `export const foo = () => flag("foo", …)`.
 */
export async function flag(name: string, envDefault: string): Promise<boolean> {
  if (!configured()) return envBool(envDefault);
  await ensureFresh();
  const v = cached?.[name];
  if (v && typeof v.enabled === "boolean") return v.enabled;
  return envBool(envDefault);
}

/** Whether session images (photo/crop) should be persisted to S3. */
export const storeImages = (): Promise<boolean> => flag("store-images", config.storeImagesDefault);

/**
 * Which extraction tiers may run — the reader-cost circuit breaker:
 *   full — GCV tier 1 + Claude tier-2 escalation (normal operation)
 *   gcv  — GCV only; every would-be Claude call lands on manual entry instead
 *   off  — no automatic reading at all; manual entry + submission still work
 * Modeled as one flag (`enabled` = the big red switch, `mode` attribute picks
 * tiers) because Claude-without-GCV is not a valid state: tier 2 reads GCV's
 * chosen-line crop, and full-photo Claude fails on small-in-frame signs.
 */
export type ExtractMode = "full" | "gcv" | "off";

const parseMode = (v: unknown): ExtractMode | null =>
  v === "full" || v === "gcv" || v === "off" ? v : null;

export async function extractMode(): Promise<ExtractMode> {
  const envDefault = parseMode(config.extractModeDefault.trim().toLowerCase()) ?? "full";
  if (!configured()) return envDefault;
  await ensureFresh();
  const v = cached?.["extract-mode"];
  if (v && typeof v.enabled === "boolean") {
    // AppConfig omits attributes on a disabled flag; enabled without a valid
    // mode (attribute deleted in the console) fails open to full.
    return v.enabled ? parseMode(v.mode) ?? "full" : "off";
  }
  return envDefault;
}
