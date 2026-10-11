# Purchase integration

1. Extend the existing backend and schema using additive migration 0004. Reuse Better Auth and wallet bindings. Reserve identity/round before signing; persist bank dispatch before external calls. Acceptance: existing and purchase recovery tests pass on actual 0001/0002/0003/0004 DDL.
2. Implement Devnet Anchor project/round/funding/subscription/allocation/refund instructions and their IDL. Validate signer/PDA/token ownership and non-transferability. Acceptance: compiled SBF, golden arithmetic and real validator replay, wrong-signer, transfer and conservation tests; simulate before deployment.
3. Add Nessie capability probe, synthetic fixtures and immutable registration. Credentials stay server-side. Unknown writes reconcile by history; never retry a bank POST. Acceptance: authenticated sandbox evidence verifies envelope/status/history/balance semantics, then one finalized guarded funding.
4. Connect a static frontend to sign-in, wallet proof, account/funding status, API round quotes, wallet signing, tracking and portfolio. Acceptance: type/lint/static build and browser happy/failure paths.

Trust: Tiger owns eligibility and durable intents; Nessie owns mock bank observations; finalized Solana accounts own tokens/settlement. Money uses BigInt and PostgreSQL bigint. Funding and subscriptions are separate actions. Frontend work is explicitly authorized by the current user request, overriding the prior contributor ownership restriction.

Vercel runs bounded on-demand reconciliation with waitUntil. GET may recover dispatched intents but never dispatch CREATED banking intents; authorized funding POST and POST /funding/:id/resume may dispatch. No persistent worker or extra service. Migration rollback disables purchase configuration and retains evidence; no historical rows are deleted or replaced.

Live checks depend on Vercel access, Tiger configuration, a Nessie key/fixtures, and a Devnet deployer. No local credentials or authenticated Vercel session were available initially. Keep Nessie disabled until provider capability evidence exists. No mock test is claimed as live banking.

Sources: [Nessie](https://prod.nessieisreal.com/docs), [Solana transactions](https://solana.com/docs/core/transactions), [non-transferable tokens](https://solana.com/docs/tokens/extensions/non-transferrable-tokens), [Anchor constraints](https://www.anchor-lang.com/docs/references/account-constraints). Existing signing adapter uses Anchor 0.32.1/web3.js v0; keep it contained to preserve exact signed-message recovery contracts.

Implementation status: additive backend integration, compiled Anchor program/IDL, read-only Nessie probe/fixture registration, finalized-event metrics, and participation UI are implemented. See [operator setup](PURCHASE_SETUP.md). Live migrations, provider verification, protocol initialization and Devnet deployment remain dependent on operator configuration. The user is logged into the new Vercel project; it currently has no environment variables. Existing fixture screens remain illustrative; real participation uses `/participate/`.
