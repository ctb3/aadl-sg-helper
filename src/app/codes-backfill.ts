import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { hiddenMessage } from "./aadl";
import { poolCandidate, recordCode } from "./codes";
import { bucket, getJson, listVersionPrefixes, s3 } from "./sessions";

/**
 * Seed the verified-code pool (sessions/_codes/) from every historical
 * submit.json across all version prefixes. Attempts are replayed globally in
 * time order so firstSeenAt is honest; recordCode's upgrade-once semantics
 * make reruns idempotent (and let a later fresh redeem fill in the hidden
 * message on an already_redeemed-seeded entry).
 *
 *   npx tsx src/app/codes-backfill.ts [--dry-run] [--replay]
 *
 * --dry-run  print what would be written, PUT nothing
 * --replay   also run the pool-correction matcher over every historical
 *            all-rejected attempt against the post-backfill pool — the
 *            offline proof of what correction would have fixed (and any
 *            suspicious snaps) before it serves live.
 */

interface Attempt {
  at: string;
  code: string;
  correctedFrom?: string;
  results: any[];
}

const ok = (x: any): boolean => x.outcome === "success" || x.outcome === "already_redeemed";
const rejected = (x: any): boolean => x.outcome === "not_recognized" || x.outcome === "close_match";

async function listSubmitKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) {
      if (o.Key!.endsWith("/submit.json")) keys.push(o.Key!);
    }
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

async function main(): Promise<void> {
  if (!bucket) throw new Error("SESSIONS_BUCKET not set");
  const dryRun = process.argv.includes("--dry-run");
  const replay = process.argv.includes("--replay");

  const attempts: Attempt[] = [];
  for (const prefix of await listVersionPrefixes()) {
    for (const key of await listSubmitKeys(prefix)) {
      const submit = await getJson(key);
      for (const a of submit?.attempts ?? []) {
        if (typeof a?.code === "string" && Array.isArray(a.results)) attempts.push(a);
      }
    }
  }
  attempts.sort((a, b) => a.at.localeCompare(b.at));
  console.log(`${attempts.length} attempt(s) across s3://${bucket}/sessions/`);

  // In-memory mirror of what the pool will contain — drives dry-run output
  // and the replay below without re-listing S3.
  const seen = new Map<string, { hasMessage: boolean }>();
  let writes = 0;
  for (const a of attempts) {
    if (!a.results.some(ok)) continue;
    const points = a.results.map((r: any) => r.points).find((p: any) => typeof p === "number");
    const message = hiddenMessage(a.results.flatMap((r: any) => r.messages ?? []));
    const prior = seen.get(a.code);
    if (!prior) seen.set(a.code, { hasMessage: !!message });
    else if (!prior.hasMessage && message) prior.hasMessage = true;
    else continue; // recordCode would skip too — keep the log write-shaped
    writes++;
    console.log(`${dryRun ? "would record" : "record"}  ${a.at.slice(0, 10)}  ${a.code}` +
      (message ? `  — ${message}` : "  (no message yet)"));
    if (!dryRun) await recordCode(a.code, { points, message: message || undefined, firstSeenAt: a.at });
  }
  console.log(`${writes} write(s), ${seen.size} distinct code(s)${dryRun ? " (dry run — nothing PUT)" : ""}`);

  if (replay) {
    const pool = [...seen.keys()];
    console.log(`\n== replay: pool correction over historical rejected attempts (pool n=${pool.length})`);
    for (const a of attempts) {
      if (a.results.some(ok) || !a.results.some(rejected)) continue;
      const cand = poolCandidate(a.code, pool);
      console.log(`${a.at.slice(0, 10)}  ${a.code.padEnd(16)} ${cand ? `WOULD-CORRECT → ${cand}` : "no unique match"}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
