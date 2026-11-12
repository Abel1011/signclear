// Live sandbox check of every PayPal call SignClear makes. Prints status + PayPal-Debug-Id per call (no secrets).
//   node --use-system-ca --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/paypal/verify-live.mts
// With PAYPAL_SEAT_VAULT_ID set it also runs the full money path on a vaulted wallet:
// authorize (vault) -> partial capture federal (final_capture=false) -> capture state (final_capture=true)
// -> refund both captures; plus reauthorize and void on a second authorization.
import { paypal, authFromOrder, type PPResult } from "../../src/lib/paypal";

const out: string[] = [];
const log = (name: string, r: PPResult<unknown>, extra = "") => {
  const b = r.body as { name?: string; status?: string; details?: Array<{ issue?: string }> } | null;
  const line = `${name.padEnd(34)} ${r.status}  debug-id ${r.debugId ?? "-"}  ${b?.status ?? b?.name ?? ""} ${b?.details?.[0]?.issue ?? ""} ${extra}`;
  out.push(line);
  console.log(line);
};
const id = Date.now();

log("GET disputes", await paypal.listDisputes({ pageSize: 5 }));
const end = new Date();
log("GET reporting/transactions", await paypal.searchTransactions({ start: new Date(end.getTime() - 7 * 86400_000), end }));
log("POST partner-referrals", await paypal.createPartnerReferral({ trackingId: `verify-${id}`, returnUrl: "http://localhost:3103/api/preparer/paypal/return" }));
log("POST vault/setup-tokens", await paypal.createSetupToken({ returnUrl: "http://localhost:3103/", cancelUrl: "http://localhost:3103/", requestId: `verify-st-${id}` }));
log(
  "POST orders (items, buyer approval)",
  await paypal.createAuthorizeOrder({ amountCents: 25000, invoiceId: `verify-${id}`, customId: "verify", description: "verify", requestId: `verify-o-${id}`, items: [{ kind: "FEDERAL", amountCents: 18000, name: "Federal" }, { kind: "STATE", amountCents: 7000, name: "State" }] }),
);

const vault = process.env.PAYPAL_SEAT_VAULT_ID;
if (!vault) console.log("\nPAYPAL_SEAT_VAULT_ID not set: skipping the vaulted money path (run scripts/paypal/vault-setup.mts first).");
else {
  const o = await paypal.createAuthorizeOrder({ amountCents: 25000, invoiceId: `verify-v-${id}`, customId: "verify", description: "verify", requestId: `verify-v-${id}`, vaultId: vault, items: [{ kind: "FEDERAL", amountCents: 18000, name: "Federal" }, { kind: "STATE", amountCents: 7000, name: "State" }] });
  let auth = authFromOrder(o.body);
  log("POST orders (vault_id)", o, `auth ${auth?.id ?? "-"}`);
  const orderId = (o.body as { id?: string } | null)?.id;
  if (!auth && orderId) {
    const a = await paypal.authorizeOrder(orderId, `verify-a-${id}`);
    auth = authFromOrder(a.body);
    log("POST orders/{id}/authorize", a);
  }
  if (auth) {
    const c1 = await paypal.capture(auth.id, `verify-c1-${id}`, { amountCents: 18000, finalCapture: false, invoiceId: `verify-v-${id}-FED` });
    log("capture federal final=false", c1);
    const c2 = await paypal.capture(auth.id, `verify-c2-${id}`, { amountCents: 7000, finalCapture: true, invoiceId: `verify-v-${id}-STATE` });
    log("capture state final=true", c2);
    log("GET authorization", await paypal.getAuthorization(auth.id));
    for (const [n, c, amt] of [["federal", c1, 18000], ["state", c2, 7000]] as const) {
      const capId = (c.body as { id?: string } | null)?.id;
      if (capId) log(`refund ${n}`, await paypal.refund(capId, `verify-r-${n}-${id}`, amt, "SignClear verification refund"));
    }
  }
  const o2 = await paypal.createAuthorizeOrder({ amountCents: 1000, invoiceId: `verify-v2-${id}`, customId: "verify", description: "verify", requestId: `verify-v2-${id}`, vaultId: vault });
  const a2 = authFromOrder(o2.body);
  log("POST orders (vault_id) #2", o2);
  if (a2) {
    log("reauthorize (honor period)", await paypal.reauthorize(a2.id, 1000, `verify-ra-${id}`));
    log("void", await paypal.void(a2.id, `verify-void-${id}`));
  }
}
