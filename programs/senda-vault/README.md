# senda-vault

Phase **5.F** Solana USDC escrow vault (Anchor 0.32.1).

Design: `internal/designs/phase-5f-escrow-vault.md` (local).

## Build / soak

```bash
anchor build
anchor test   # localnet validator: deposit → settle → claim → refund → pause
```

Localnet soak (2026-08-04): **9/9 passing** — admin ≠ oracle enforced; replay settle rejected; vault ATA invariant holds after claim/refund/margin withdraw. Public-devnet deploy pending faucet SOL (airdrop rate-limited).
## Instructions

| Ix | Who | Notes |
|---|---|---|
| `initialize` | deployer | Config + margin + vault ATA; starts **paused** |
| `set_params` / `pause` / `unpause` | admin | Params + kill switch |
| `deposit` | customer | USDC → vault; credit customer PDA |
| `oracle_settle_batch` | oracle | One line/ix; batch_id PDA idempotency |
| `peer_claim` | peer | Pull ≥ min_claim to peer ATA |
| `customer_refund` | oracle | refund_id PDA idempotency |
| `admin_withdraw_margin` | admin | Margin → destination ATA |

## Defaults

- `min_deposit` $5 · `min_claim` $10 · `max_tvl` $1000 · `settle_fee_bps` 0
- Mainnet init blocked on **G0** (Squads, oracle ≠ admin)

## Program id (public) vs keys (never commit)

- Public program id is in `PROGRAM_ID`, `declare_id!`, and `Anchor.toml`.
- Deploy / soak keypairs live only under `programs/senda-vault/.keys/` and `target/deploy/` — both gitignored. Do not commit treasury, payer, peer, or deployer addresses used for testing; those stay in Vercel/env or local `.keys/`.

Restore deploy keypair before `anchor deploy` if `target/deploy/` was cleaned:

```bash
mkdir -p target/deploy
cp programs/senda-vault/.keys/senda_vault-keypair.json target/deploy/senda_vault-keypair.json
```

## Safety

Do not deploy mainnet or unpause deposits until G0–G2 in the design spike are green. Custodial Redis rail remains primary until dual-write migration.
