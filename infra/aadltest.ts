import { AuthExpiredError, aadlLogin, connect, fetchRedeemForm, loadJar, serializeJar, submitCode } from "../src/app/aadl";

/**
 * Live integration test for src/app/aadl.ts against aadl.org — run manually:
 *   npx tsx infra/aadltest.ts [CODE]
 * Needs AADL_USERNAME/AADL_PASSWORD in .env (the test account). Only traceless
 * outcomes by default: a gibberish code ("not recognized" leaves no ledger row).
 * Pass a real CODE to exercise the success path — it will actually redeem
 * (repeat runs return already_redeemed, which is equally verifiable).
 */

const user = process.env.AADL_USERNAME ?? "";
const pass = process.env.AADL_PASSWORD ?? "";
if (!user || !pass) {
  console.error("AADL_USERNAME / AADL_PASSWORD not set in .env");
  process.exit(1);
}
const realCode = process.argv[2];

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // 1. bad password fails cleanly (wrong-password guess, not the real one)
  try {
    await aadlLogin(user, pass + "-wrong");
    check("bad-password", false, "login unexpectedly succeeded");
  } catch (err: any) {
    check("bad-password", /rejected|blocked/i.test(String(err?.message)), String(err?.message));
  }

  // 2. connect: login + player discovery
  const conn = await connect(user, pass);
  check("connect", conn.players.length >= 1, `players=${JSON.stringify(conn.players)}`);

  // 3. round-trip the serialized jar like the client does
  const jar = loadJar(conn.cookies);
  const form = await fetchRedeemForm(jar);
  check("redeem-form", !!form.formBuildId && form.pid > 0,
    `pid=${form.pid} token=${form.formToken ? "yes" : "no"} action=${form.actionUrl}`);

  // 4. gibberish code → not_recognized (traceless on the AADL side)
  const gibberish = "ZZQX" + Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const r1 = await submitCode(jar, gibberish, form.players.map((p) => p.pid));
  check("gibberish", r1.outcome === "not_recognized" || r1.outcome === "close_match",
    `code=${gibberish} outcome=${r1.outcome} msgs=${JSON.stringify(r1.messages)}`);

  // 5. real code (opt-in) → success or already_redeemed
  if (realCode) {
    const r2 = await submitCode(jar, realCode, form.players.map((p) => p.pid));
    check("real-code", r2.outcome === "success" || r2.outcome === "already_redeemed",
      `outcome=${r2.outcome} points=${r2.points} msgs=${JSON.stringify(r2.messages)}`);
  } else {
    console.log("skip  real-code  (pass a CODE argument to exercise the success path)");
  }

  // 6. corrupted jar → AuthExpiredError
  try {
    const stale = loadJar(serializeJar(jar));
    for (const k of [...stale.keys()]) stale.set(k, "expired-nonsense");
    await fetchRedeemForm(stale);
    check("expired-session", false, "no error on a garbage session");
  } catch (err) {
    check("expired-session", err instanceof AuthExpiredError, String(err));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall good");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
