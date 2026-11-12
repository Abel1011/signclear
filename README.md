# SignClear

**Never sign a tax return you can't read.**

SignClear is a trust layer between a tax preparer, human or AI agent, and the taxpayer:

- **AI** (Claude) explains every line of the return in the client's language and catches problems before they sign.
- **PayPal** holds the preparer's fee. Deterministic code decides when the money moves.

> AI explains. Code decides. PayPal enforces.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) · Demo video: https://youtu.be/7PeLDMjWURM

---

## The problem

Families pay the preparer up front and sign a return they can't read. The IRS warns about "ghost" preparers. They don't sign the return, put the client's refund in their own bank account, and ask for cash ([irs.gov/help/tax-scams](https://www.irs.gov/help/tax-scams)). By the time the family notices, the preparer has been paid.

## What SignClear does

| Moment | What happens | PayPal call |
|---|---|---|
| Before signing | Clara (Claude) compares the return with the client's documents and interview, in Spanish, English or Portuguese. A refund routed to a foreign account blocks approval. | none, no money moves |
| Client approves | The client approves in the real PayPal checkout. The fee is **held, not charged**. | Orders v2 `intent=AUTHORIZE` → authorize |
| Preparer asks to be paid early | The AI agent may *request* a capture. Code refuses it: there is no IRS acceptance on file. | none, the request is refused |
| IRS acknowledgment arrives | The reader extracts the document. Code verifies status, submission ID, EFIN and taxpayer. | `POST /v2/payments/authorizations/{id}/capture` (partial federal/state, `final_capture`) |
| Not filed in time | The hold is released. | void (reauthorize inside the honor period when needed) |
| Refund diverted | The IRS transcript is reconciled arithmetically (R14). After a 72-hour window for the preparer to answer, the fee goes back to the client. | `POST /v2/payments/captures/{id}/refund` |

### More features

**For AI preparers**
- REST API at `/api/v1` (OpenAPI 3.1, hashed `sk_sc_` keys, idempotency keys, rate limits).
- MCP server at `/api/mcp` (Streamable HTTP) with 7 tools: `create_client_case`, `submit_return_for_client_review`, `get_case_status`, `list_cases`, `record_efile_submission`, `upload_irs_acknowledgment`, `request_fee_capture`.

**Agent Arena** (`/arena`)
- The same Claude agent does the same job in two worlds: without SignClear and with SignClear.
- Scenarios: honest, malicious, impatient, and forged IRS acceptance.

**Fraud Lab** (`/lab`)
- An unseen set: 57 returns (31 with fraud) from 9 new preparers.
- Each one was read as a clean PDF, a scan and a phone photo (171 documents), some with hidden prompt injections.
- The lab shows both what was stopped and what it costs.

**Ghost-preparer Radar** (`/radar`)
- Cross-client patterns: one refund account for many clients, the same unrequested credit again and again, abnormal EITC rates, blank preparer sections.

**AG Grid** (6 grids)
- The client's line-by-line comparison, with **"ask the table in any language"**. It is built on the AG Grid AI Toolkit: `getStructuredSchema` → Claude → validated `api.setState()`.
- The PayPal ledger, the preparer's desk, Clara's audit log, Fraud Lab results, and the Radar.

## How it's built

**PayPal (sandbox)**
- Orders v2 + JS SDK Smart Buttons (`@paypal/react-paypal-js`).
- Payments v2: authorize, reauthorize, capture (partial with `final_capture`), void, refund.
- Vault v3 (judge-seat wallet).
- Webhooks with reconciliation, the Disputes API, and a Transaction Search ledger (when enabled on the account).
- Every call is logged with its real sandbox ID and `PayPal-Debug-Id` (`src/lib/paypal.ts`, `src/lib/money.ts`).

**Claude (Anthropic SDK)**
- **Quarantined reader** (`src/lib/reader.ts`, `READER_MODEL`, default `claude-opus-5-5`): structured output validated with Zod. It extracts values only and never decides.
- **Clara** (`src/lib/agent.ts`, `AGENT_MODEL`, default `claude-sonnet-5-5`): a tool-using agent that explains, answers, drafts and *proposes*.
- **Deterministic guardians** (`src/lib/money.ts`, `src/lib/rules.ts`, `src/lib/rules-extra.ts`, `src/lib/radar.ts`): every money move must pass them.

**Stack**
- Next.js 15 (App Router), TypeScript, Tailwind v4.
- Prisma 6 + SQLite.
- AG Grid 36 (Community + Enterprise).
- MCP TypeScript SDK.
- Vitest (162 tests).

```
src/
  app/            pages (/, /c/[token] client, /p/[token] preparer, /arena, /lab, /radar, /connect) + API routes
  lib/            engine, money guardians, PayPal client, reader, agent, rules, radar, tour, platform (API/MCP)
  components/     client app, preparer desk, Clara chat, AG Grid grids, 90-second tour
prisma/           schema + migrations
data/lab/         Fraud Lab corpus and recorded reads/results
scripts/          lab runner, PayPal vault setup, sample PDF generators, video recorders
tests/            unit + integration tests (PayPal mocked)
```

## Run it locally

Requirements: Node.js 20+, a PayPal **sandbox** app, and an Anthropic API key.

```bash
git clone https://github.com/<your-user>/signclear.git
cd signclear
npm install
cp .env.example .env.local     # then fill in the values below
npx prisma migrate deploy      # creates prisma/dev.db
npm run build
npm start                      # http://localhost:3000
# or: npm run dev
```

Minimum `.env.local`:

```bash
DATABASE_URL="file:./dev.db"
PAYPAL_CLIENT_ID=...            # sandbox app
PAYPAL_CLIENT_SECRET=...
NEXT_PUBLIC_PAYPAL_CLIENT_ID=... # same as PAYPAL_CLIENT_ID
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
ANTHROPIC_API_KEY=...
```

### Optional: the judge-seat wallet (Vault v3)

The 90-second story authorizes with a vaulted sandbox wallet, so it runs without the PayPal popup. Create it once:

```bash
npx tsx --env-file=.env.local scripts/paypal/vault-setup.mts
# open the printed approval URL and log in with a SANDBOX personal account, then:
npx tsx --env-file=.env.local scripts/paypal/vault-setup.mts finish <SETUP_TOKEN_ID>
# put the printed payment token id in PAYPAL_SEAT_VAULT_ID
```

Without it, everything else works: you approve with the PayPal button and any sandbox personal account.

### Tests

```bash
npm test
```

## Try it

1. **90 seconds:** on the home page click **"Watch SignClear in 90 seconds"**. One real case runs end to end with the real engine and real PayPal sandbox calls:
   - fraud caught before signing
   - corrected return
   - AUTHORIZE
   - early capture refused
   - IRS acknowledgment verified
   - CAPTURE
   - refund short
   - IRS transcript
   - 72-hour window
   - REFUND

   Click **"Take over from here"** at any step to drive it yourself.
2. **Approve with PayPal:** on María's screen, "Approve and hold $250 with PayPal" opens the real sandbox checkout. Log in with any PayPal sandbox personal account.
3. **Sample documents:**
   - `public/samples/maria-1040-TY2025-SAMPLE.pdf` (honest return)
   - `public/samples/maria-1040-TY2025-FRAUD.pdf` (refund diverted)
   - `public/samples/ack/`
4. `/arena`, `/lab`, `/radar` and `/connect` (API keys + MCP install line).

What's simulated (and labeled as such in the UI): IRS documents (acknowledgments, transcripts) and the clock used for the 72-hour window. The rules engine, Claude and the PayPal sandbox calls are real.

## Responsible AI notes

- The model never moves money. Every capture, void or refund passes deterministic guardians first. Their refusal reasons are shown to the user.
- The reader is quarantined: document text, including injected instructions, is treated as data and extracted into a fixed schema.
- SignClear explains the client's own documents. It is not tax advice.
- The Fraud Lab publishes false positives as well as catches. The headline view re-scores reads with today's rules, which were adjusted after the first unseen run. This is stated in the UI.

## License

[MIT](LICENSE)
