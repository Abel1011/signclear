// Judge-seat wallet (Vault v3, sandbox). Two steps:
//   1) node --use-system-ca --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/paypal/vault-setup.mts
//      -> creates a setup token and prints the approval URL. Open it and log in with the SANDBOX BUYER (a person does this).
//   2) node --use-system-ca --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/paypal/vault-setup.mts finish <SETUP_TOKEN_ID>
//      -> exchanges the approved setup token for a payment token; put its id in PAYPAL_SEAT_VAULT_ID.
// Never prints client credentials.
import { paypal } from "../../src/lib/paypal";

const [cmd, arg] = process.argv.slice(2);
const base = process.env.APP_BASE_URL ?? "http://localhost:3103";

if (!cmd) {
  const r = await paypal.createSetupToken({ returnUrl: `${base}/?vault=approved`, cancelUrl: `${base}/?vault=cancelled`, requestId: `seat-setup-${Date.now()}` });
  console.log(`POST /v3/vault/setup-tokens -> ${r.status} debug-id ${r.debugId}`);
  if (!r.ok || !r.body?.id) {
    console.error(JSON.stringify(r.body, null, 2));
    process.exit(1);
  }
  const approve = r.body.links?.find((l) => l.rel === "approve")?.href;
  console.log(`setup token: ${r.body.id} (status ${r.body.status})`);
  console.log(`\n1. Open this URL and approve with the sandbox BUYER account:\n   ${approve}`);
  console.log(`2. Then run: ... vault-setup.mts finish ${r.body.id}`);
} else if (cmd === "finish" && arg) {
  const r = await paypal.createPaymentToken(arg, `seat-token-${arg}`);
  console.log(`POST /v3/vault/payment-tokens -> ${r.status} debug-id ${r.debugId}`);
  if (!r.ok || !r.body?.id) {
    console.error(JSON.stringify(r.body, null, 2));
    console.error("If the status is 422 the setup token is not approved yet (or expired: setup tokens last ~3 days). Re-run step 1.");
    process.exit(1);
  }
  console.log(`\nAdd to .env.local (and the deployment):\nPAYPAL_SEAT_VAULT_ID=${r.body.id}`);
  if (r.body.customer?.id) console.log(`(vault customer id ${r.body.customer.id})`);
} else {
  console.error("usage: vault-setup.mts            -> create setup token\n       vault-setup.mts finish <id> -> create payment token");
  process.exit(2);
}
