// Localnet soak for senda-vault (F2-F5). Run via: anchor test
// Vitest ignores this file (its include is only under app/).
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { SendaVault } from "../target/types/senda_vault";

const CONFIG_SEED = Buffer.from("senda-vault-config");
const AUTH_SEED = Buffer.from("senda-vault-auth");
const CUST_SEED = Buffer.from("senda-cust");
const PEER_SEED = Buffer.from("senda-peer");
const MARGIN_SEED = Buffer.from("senda-margin");
const BATCH_SEED = Buffer.from("senda-batch");
const REFUND_SEED = Buffer.from("senda-refund");

describe("senda-vault soak", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sendaVault as Program<SendaVault>;
  const connection = provider.connection;
  const deployer = (provider.wallet as anchor.Wallet).payer;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const customer = Keypair.generate();
  const peer = Keypair.generate();

  let mint: PublicKey;
  let config: PublicKey;
  let vaultAuthority: PublicKey;
  let vaultAta: PublicKey;
  let margin: PublicKey;
  let customerAta: PublicKey;
  let peerAta: PublicKey;
  let customerEscrow: PublicKey;
  let peerEscrow: PublicKey;

  const DECIMALS = 6;
  const DEPOSIT = 20_000_000; // $20
  const DEBIT = 12_000_000; // $12
  const PEER_CREDIT = 10_000_000; // $10 (min claim)
  const MARGIN_CREDIT = 2_000_000; // $2
  const REFUND = 5_000_000; // $5 of remaining customer balance

  async function fund(kp: Keypair, sol = 2) {
    const sig = await connection.requestAirdrop(
      kp.publicKey,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig, "confirmed");
  }

  before(async () => {
    await fund(admin);
    await fund(oracle);
    await fund(customer);
    await fund(peer);

    mint = await createMint(
      connection,
      deployer,
      deployer.publicKey,
      null,
      DECIMALS,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    [config] = PublicKey.findProgramAddressSync(
      [CONFIG_SEED, mint.toBuffer()],
      program.programId
    );
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [AUTH_SEED, mint.toBuffer()],
      program.programId
    );
    vaultAta = getAssociatedTokenAddressSync(
      mint,
      vaultAuthority,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    [margin] = PublicKey.findProgramAddressSync([MARGIN_SEED], program.programId);
    [customerEscrow] = PublicKey.findProgramAddressSync(
      [CUST_SEED, customer.publicKey.toBuffer()],
      program.programId
    );
    [peerEscrow] = PublicKey.findProgramAddressSync(
      [PEER_SEED, peer.publicKey.toBuffer()],
      program.programId
    );

    customerAta = await createAssociatedTokenAccount(
      connection,
      deployer,
      mint,
      customer.publicKey,
      undefined,
      TOKEN_PROGRAM_ID
    );
    peerAta = await createAssociatedTokenAccount(
      connection,
      deployer,
      mint,
      peer.publicKey,
      undefined,
      TOKEN_PROGRAM_ID
    );

    await mintTo(
      connection,
      deployer,
      mint,
      customerAta,
      deployer,
      DEPOSIT * 2,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );
  });

  it("initialize (paused) with admin ≠ oracle", async () => {
    expect(admin.publicKey.equals(oracle.publicKey)).to.eq(false);

    await program.methods
      .initialize(admin.publicKey, oracle.publicKey)
      .accountsPartial({
        deployer: deployer.publicKey,
        usdcMint: mint,
        config,
        vaultAuthority,
        vaultAta,
        margin,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const cfg = await program.account.vaultConfig.fetch(config);
    expect(cfg.paused).to.eq(true);
    expect(cfg.admin.toBase58()).to.eq(admin.publicKey.toBase58());
    expect(cfg.oracle.toBase58()).to.eq(oracle.publicKey.toBase58());
    expect(cfg.maxTvlAtomic.toNumber()).to.eq(1_000_000_000);
    expect(cfg.minClaimAtomic.toNumber()).to.eq(10_000_000);
    expect(cfg.minDepositAtomic.toNumber()).to.eq(5_000_000);
  });

  it("deposit blocked while paused", async () => {
    try {
      await program.methods
        .deposit(new BN(DEPOSIT))
        .accountsPartial({
          customer: customer.publicKey,
          config,
          usdcMint: mint,
          vaultAuthority,
          vaultAta,
          customerAta,
          customerEscrow,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([customer])
        .rpc();
      expect.fail("expected paused error");
    } catch (e: any) {
      expect(String(e)).to.match(/Paused|paused/i);
    }
  });

  it("admin unpause then customer deposit", async () => {
    await program.methods
      .unpause()
      .accountsPartial({ admin: admin.publicKey, config })
      .signers([admin])
      .rpc();

    await program.methods
      .deposit(new BN(DEPOSIT))
      .accountsPartial({
        customer: customer.publicKey,
        config,
        usdcMint: mint,
        vaultAuthority,
        vaultAta,
        customerAta,
        customerEscrow,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([customer])
      .rpc();

    const cust = await program.account.customerEscrow.fetch(customerEscrow);
    expect(cust.availableAtomic.toNumber()).to.eq(DEPOSIT);
    const vault = await getAccount(connection, vaultAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(vault.amount)).to.eq(DEPOSIT);
  });

  it("oracle settle: debit customer, credit peer + margin", async () => {
    const batchId = Array.from({ length: 16 }, (_, i) => i + 1);
    const [batchReceipt] = PublicKey.findProgramAddressSync(
      [BATCH_SEED, Buffer.from(batchId)],
      program.programId
    );

    await program.methods
      .oracleSettleBatch(
        batchId,
        new BN(DEBIT),
        new BN(PEER_CREDIT),
        new BN(MARGIN_CREDIT)
      )
      .accountsPartial({
        oracle: oracle.publicKey,
        config,
        customerWallet: customer.publicKey,
        customerEscrow,
        peerWallet: peer.publicKey,
        peerEscrow,
        margin,
        batchReceipt,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const cust = await program.account.customerEscrow.fetch(customerEscrow);
    expect(cust.availableAtomic.toNumber()).to.eq(DEPOSIT - DEBIT);
    const peerAcc = await program.account.peerEscrow.fetch(peerEscrow);
    expect(peerAcc.availableAtomic.toNumber()).to.eq(PEER_CREDIT);
    const m = await program.account.marginEscrow.fetch(margin);
    expect(m.availableAtomic.toNumber()).to.eq(MARGIN_CREDIT);
  });

  it("replay settle rejected (idempotency)", async () => {
    const batchId = Array.from({ length: 16 }, (_, i) => i + 1);
    const [batchReceipt] = PublicKey.findProgramAddressSync(
      [BATCH_SEED, Buffer.from(batchId)],
      program.programId
    );
    try {
      await program.methods
        .oracleSettleBatch(
          batchId,
          new BN(DEBIT),
          new BN(PEER_CREDIT),
          new BN(MARGIN_CREDIT)
        )
        .accountsPartial({
          oracle: oracle.publicKey,
          config,
          customerWallet: customer.publicKey,
          customerEscrow,
          peerWallet: peer.publicKey,
          peerEscrow,
          margin,
          batchReceipt,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
      expect.fail("expected duplicate batch error");
    } catch (e: any) {
      expect(String(e)).to.match(/already in use|0x0|Allocate/i);
    }
  });

  it("peer claim ≥ min", async () => {
    await program.methods
      .peerClaim(new BN(PEER_CREDIT))
      .accountsPartial({
        peer: peer.publicKey,
        config,
        usdcMint: mint,
        vaultAuthority,
        vaultAta,
        peerEscrow,
        peerAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([peer])
      .rpc();

    const peerAcc = await program.account.peerEscrow.fetch(peerEscrow);
    expect(peerAcc.availableAtomic.toNumber()).to.eq(0);
    const ata = await getAccount(connection, peerAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(ata.amount)).to.eq(PEER_CREDIT);
  });

  it("oracle customer refund", async () => {
    const refundId = Array.from({ length: 16 }, (_, i) => 100 + i);
    const [refundReceipt] = PublicKey.findProgramAddressSync(
      [REFUND_SEED, Buffer.from(refundId)],
      program.programId
    );
    const beforeCust = (
      await program.account.customerEscrow.fetch(customerEscrow)
    ).availableAtomic.toNumber();
    const beforeAta = Number(
      (await getAccount(connection, customerAta, undefined, TOKEN_PROGRAM_ID)).amount
    );

    await program.methods
      .customerRefund(refundId, new BN(REFUND))
      .accountsPartial({
        oracle: oracle.publicKey,
        config,
        usdcMint: mint,
        vaultAuthority,
        vaultAta,
        customerWallet: customer.publicKey,
        customerEscrow,
        customerAta,
        refundReceipt,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([oracle])
      .rpc();

    const afterCust = (
      await program.account.customerEscrow.fetch(customerEscrow)
    ).availableAtomic.toNumber();
    const afterAta = Number(
      (await getAccount(connection, customerAta, undefined, TOKEN_PROGRAM_ID)).amount
    );
    expect(afterCust).to.eq(beforeCust - REFUND);
    expect(afterAta).to.eq(beforeAta + REFUND);
  });

  it("admin withdraw margin + pause", async () => {
    const destAta = await createAssociatedTokenAccount(
      connection,
      deployer,
      mint,
      admin.publicKey,
      undefined,
      TOKEN_PROGRAM_ID
    );

    await program.methods
      .adminWithdrawMargin(new BN(MARGIN_CREDIT))
      .accountsPartial({
        admin: admin.publicKey,
        config,
        usdcMint: mint,
        vaultAuthority,
        vaultAta,
        margin,
        destination: admin.publicKey,
        destinationAta: destAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const m = await program.account.marginEscrow.fetch(margin);
    expect(m.availableAtomic.toNumber()).to.eq(0);

    await program.methods
      .pause()
      .accountsPartial({ admin: admin.publicKey, config })
      .signers([admin])
      .rpc();
    const cfg = await program.account.vaultConfig.fetch(config);
    expect(cfg.paused).to.eq(true);

    // Invariant: vault ATA == Σ remaining customer + peer + margin
    const custAvail = (
      await program.account.customerEscrow.fetch(customerEscrow)
    ).availableAtomic.toNumber();
    const peerAvail = (
      await program.account.peerEscrow.fetch(peerEscrow)
    ).availableAtomic.toNumber();
    const marginAvail = (
      await program.account.marginEscrow.fetch(margin)
    ).availableAtomic.toNumber();
    const vaultAmt = Number(
      (await getAccount(connection, vaultAta, undefined, TOKEN_PROGRAM_ID)).amount
    );
    expect(vaultAmt).to.eq(custAvail + peerAvail + marginAvail);
    // After claim+refund+margin withdraw: remaining = DEPOSIT - DEBIT - REFUND + 0 peer + 0 margin
    // Wait: deposit 20, debit 12 (10 peer + 2 margin leave as liabilities then:
    // peer claim removes 10 from vault, refund removes 5, margin withdraw removes 2
    // customer left: 20-12-5=3; vault should be 3
    expect(vaultAmt).to.eq(DEPOSIT - PEER_CREDIT - REFUND - MARGIN_CREDIT);
    expect(custAvail).to.eq(DEPOSIT - DEBIT - REFUND);
  });

  it("admin ≠ oracle: oracle cannot pause", async () => {
    try {
      await program.methods
        .pause()
        .accountsPartial({ admin: oracle.publicKey, config })
        .signers([oracle])
        .rpc();
      expect.fail("oracle must not pause");
    } catch (e: any) {
      expect(String(e)).to.match(/UnauthorizedAdmin|ConstraintHasOne|custom program error/i);
    }
  });
});
