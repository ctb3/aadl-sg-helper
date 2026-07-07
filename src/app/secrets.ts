import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { config } from "../core/config";

/**
 * Runtime secret loading. The Lambda env carries SSM parameter NAMES
 * (APP_PIN_SSM_PARAM, GCP_SA_KEY_SSM_PARAM), never values — so nothing secret
 * lands in Terraform state or lambda:GetFunctionConfiguration output. The
 * server awaits this before listen(); values are fetched once per cold start.
 *
 * Local dev is unchanged: a value already present in the env (APP_PIN from
 * .env, GOOGLE_APPLICATION_CREDENTIALS instead of GCP_SA_KEY_JSON) wins, and
 * without the *_SSM_PARAM pointers this is a no-op.
 */
const SECRET_PARAMS: [envName: string, paramEnv: string][] = [
  ["APP_PIN", "APP_PIN_SSM_PARAM"],
  ["GCP_SA_KEY_JSON", "GCP_SA_KEY_SSM_PARAM"],
];

export async function loadSecrets(): Promise<void> {
  const pending = SECRET_PARAMS.filter(
    ([envName, paramEnv]) => !process.env[envName] && process.env[paramEnv],
  );
  if (!pending.length) return;
  const ssm = new SSMClient({ region: config.awsRegion });
  await Promise.all(
    pending.map(async ([envName, paramEnv]) => {
      const res = await ssm.send(
        new GetParameterCommand({ Name: process.env[paramEnv], WithDecryption: true }),
      );
      const value = res.Parameter?.Value;
      if (!value) throw new Error(`SSM parameter ${process.env[paramEnv]} is empty`);
      process.env[envName] = value;
    }),
  );
}
