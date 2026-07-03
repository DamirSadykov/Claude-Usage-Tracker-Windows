# resolver

Neutral event resolver for the external-integration feature — plan
`External-integration-public-side` (CC-task #77), phase 3.

Standalone Rust + axum crate, **not** part of the `src-tauri` desktop app: it
builds and deploys independently (LAN Windows server now, Docker/Linux later).
Contract it implements: `../docs/plans/external-integration-contract.md`.

It is domain-neutral — it routes envelopes by `recipient` and never reads or logs
`payload` (sanitisation happens upstream, in the private `external module`).

## Run

```sh
cd resolver
cargo run
```

Configuration is entirely from the environment:

| Var | Default | Meaning |
|---|---|---|
| `RESOLVER_BIND` | `127.0.0.1:8787` | Listen address. Use `0.0.0.0:8787` on the LAN server. |
| `RESOLVER_STORE` | `resolver-store.json` | Persistent store path (accounts + mailbox). |
| `RESOLVER_INGEST_TOKENS` | *(empty)* | `source:token` pairs, comma-separated. Repeat a source for a rotation set: `svc-a:tok1,svc-a:tok2,svc-b:tok3`. |
| `RESOLVER_POLL_SKEW_SECS` | `300` | Freshness window for the poll timestamp (replay bound). |
| `RESOLVER_ENROLL_CODE_TTL_SECS` | `600` | Default pairing-code lifetime when `register-code` omits `ttl_secs`. |

TLS is terminated in front of the resolver (internal cert / mTLS on the LAN, not a
public cert) — tokens and signatures assume a confidential channel.

## Endpoints

- `GET /health` → `ok`.
- `POST /ingest` — from the `external module`. `Authorization: Bearer <token>`
  (must be valid **for the envelope's `source`**), body = the neutral envelope
  (contract §1.1). `202` new, `200` duplicate, `401` bad/missing token.
- `POST /poll` — from an `instance` (device). Body:
  ```json
  { "device_id": "…", "ts": "2026-07-02T10:00:00Z", "signature": "<base64>" }
  ```
  `signature` is Ed25519 over the exact bytes of `"{device_id}|{ts}"`. Returns the
  device's undelivered messages (and marks them delivered); `401` on unknown
  device, bad signature, or stale `ts`. **Phase 5 (instance client) must sign this
  exact challenge string.**
- `POST /enroll/register-code` — from the corp service (enrollment, Flow B: the
  corp mints the code). Same per-source `Authorization: Bearer <ingest-token>` as
  `/ingest`. Body:
  ```json
  { "source": "svc-a", "code_hash": "<sha256 hex lower>", "account_email": "user@corp", "ttl_seconds": 300 }
  ```
  The corp side hashes the code — **the raw code never reaches the resolver**. The
  `code_hash` is stored verbatim and matched later against `hash(proof)`.
  `ttl_seconds > 0` = one-time code with that TTL; `ttl_seconds <= 0` = an **eternal**
  token (never expires, and **not** quenched on `bind` — reusable across devices, an
  opt-in for "one list of tokens, distributed forever"); absent = default TTL.
  `201 {expires_at}` (null when eternal) ok, `400` empty `account_email` / malformed
  `code_hash`, `401` bad/missing/mismatched token.
- `POST /enroll/bind` — from an `instance` (device) redeeming the code the user
  typed in. No ingest token; the `proof` *is* the credential. Body:
  ```json
  { "proof": "<raw code>", "public_key": "<Ed25519 base64>", "device_id": "…" }
  ```
  Resolves `hash(proof) → account`, appends the device to `accounts[account]`, and
  **quenches the code** (one-time). `200 {account, enrolled_at}` ok, `400` bad
  public key / empty fields, `401` unknown/expired/spent code. `proof` is a pairing
  code now, an SSO `id_token` later — swapping it never changes this contract.

## Dedup & retention

Dedup key is **`(source, recipient, id)`** (contract §"Дедупликация"). The private
side additionally bakes the recipient into `id`, so `(source, id)` and
`(source, recipient, id)` partition identically — the two sides interoperate
regardless. Delivered messages are **not** pruned in the MVP, which satisfies the
private side's retention requirement (a late retry past delivery is still caught as
a duplicate). Retention-based pruning is a later decision.

## Notes / deferred hardening

- **Poll replay within the freshness window** is possible (stateless challenge). A
  server-issued nonce endpoint closes it; deferred past the MVP.
- **Enrollment** (populating `accounts`) is live via `/enroll/register-code` +
  `/enroll/bind` (phase 4, Flow B — the corp service mints the code). Editing the
  store JSON to seed devices by hand still works for dev/tests. The resolver only
  ever sees `hash(code)`; code entropy is the corp generator's responsibility (the
  private side uses a short human-typed code guarded by a short TTL + rate-limit +
  one-time use).
- **Bind is one-time**: a retry after a lost `200` returns `401`; the client
  confirms binding by a successful `poll`, not by re-`bind`. In-window replay of a
  bind (like poll) is not yet closed by a server nonce — deferred past the MVP.
- `auth::verify_b64` is a deliberate copy of `src-tauri/src/identity.rs::verify_b64`
  (separate deployables, no shared crate) — keep the two in sync.
