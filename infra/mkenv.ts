import "dotenv/config";
import fs from "node:fs";

/**
 * Deploy-time generator (called by infra/deploy.sh):
 *   npx tsx infra/mkenv.ts <sessions-bucket>
 * Reads .env, writes the two account-specific JSON payloads the AWS CLI needs:
 *   infra/.lambda-env.json   — Lambda environment (includes the GCP key inline)
 *   infra/.role-policy.json  — execution-role inline policy (Bedrock + bucket)
 * Both are gitignored; nothing secret ever lands in the image or the repo.
 */

const bucket = process.argv[2];
if (!bucket) {
  console.error("usage: npx tsx infra/mkenv.ts <sessions-bucket>");
  process.exit(1);
}

const pin = process.env.APP_PIN ?? "";
if (!pin) {
  console.error("APP_PIN must be set in .env — the Function URL is public, the PIN is the gate.");
  process.exit(1);
}

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "";
if (!keyPath || !fs.existsSync(keyPath)) {
  console.error(`GOOGLE_APPLICATION_CREDENTIALS does not point at a readable file: "${keyPath}"`);
  process.exit(1);
}
const gcpKey = JSON.stringify(JSON.parse(fs.readFileSync(keyPath, "utf8"))); // minify

const Variables: Record<string, string> = {
  APP_PIN: pin,
  SESSIONS_BUCKET: bucket,
  GCP_SA_KEY_JSON: gcpKey,
  CLAUDE_READER_MODEL: process.env.CLAUDE_READER_MODEL ?? "us.anthropic.claude-sonnet-5",
  CLAUDE_THINKING: process.env.CLAUDE_THINKING ?? "disabled",
};

const env = JSON.stringify({ Variables });
const bytes = Buffer.byteLength(env);
if (bytes > 4096) {
  console.error(`Lambda env payload is ${bytes}B (limit 4096B) — move GCP_SA_KEY_JSON to SSM/Secrets Manager.`);
  process.exit(1);
}
fs.writeFileSync("infra/.lambda-env.json", env);

const policy = {
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["bedrock:InvokeModel"], Resource: "*" },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: `arn:aws:s3:::${bucket}/sessions/*`,
    },
  ],
};
fs.writeFileSync("infra/.role-policy.json", JSON.stringify(policy, null, 2));

console.log(`wrote infra/.lambda-env.json (${bytes}B) + infra/.role-policy.json for bucket ${bucket}`);
