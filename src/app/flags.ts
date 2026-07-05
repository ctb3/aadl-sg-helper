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
let cached: Record<string, { enabled?: boolean } | undefined> = {};
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

const envBool = (v: string): boolean => !["off", "false", "0", "no"].includes(v.trim().toLowerCase());

/**
 * Generic boolean flag read. Uses the AppConfig value when present; otherwise
 * (unconfigured / unreachable / flag missing) falls back to `envDefault`.
 * Adding a second flag is a one-liner: `export const foo = () => flag("foo", …)`.
 */
export async function flag(name: string, envDefault: string): Promise<boolean> {
  if (!configured()) return envBool(envDefault);
  await refresh();
  const v = cached?.[name];
  if (v && typeof v.enabled === "boolean") return v.enabled;
  return envBool(envDefault);
}

/** Whether session images (photo/crop) should be persisted to S3. */
export const storeImages = (): Promise<boolean> => flag("store-images", config.storeImagesDefault);
