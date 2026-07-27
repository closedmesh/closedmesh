import { describe, expect, it } from "vitest";
import { Keypair, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  extractDeposits,
  extractDepositsByOwnerDelta,
  extractDepositsFromSplTransfers,
} from "./solana-deposits";
import { SOLANA_USDC_MINT } from "./solana-config";

const TREASURY = Keypair.generate().publicKey.toBase58();
const SENDER = Keypair.generate().publicKey.toBase58();
const TREASURY_ATA = Keypair.generate().publicKey;
const SENDER_ATA = Keypair.generate().publicKey;
const TOKEN_PROGRAM = Keypair.generate().publicKey;

function fakeTx(input: {
  sig: string;
  treasury: string;
  from: string;
  treasuryPre: string;
  treasuryPost: string;
  fromPre: string;
  fromPost: string;
  spl?: boolean;
}): ParsedTransactionWithMeta {
  const instructions = input.spl
    ? [
        {
          program: "spl-token",
          programId: TOKEN_PROGRAM,
          parsed: {
            type: "transferChecked",
            info: {
              authority: input.from,
              source: SENDER_ATA.toBase58(),
              destination: TREASURY_ATA.toBase58(),
              mint: SOLANA_USDC_MINT,
              tokenAmount: { amount: "5000000", decimals: 6 },
            },
          },
        },
      ]
    : [];

  return {
    transaction: {
      signatures: [input.sig],
      message: {
        accountKeys: [
          { pubkey: Keypair.generate().publicKey, signer: true, writable: true },
          { pubkey: TREASURY_ATA, signer: false, writable: true },
          { pubkey: SENDER_ATA, signer: false, writable: true },
        ],
        instructions,
        recentBlockhash: "",
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: SOLANA_USDC_MINT,
          owner: input.treasury,
          uiTokenAmount: {
            amount: input.treasuryPre,
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
        },
        {
          accountIndex: 2,
          mint: SOLANA_USDC_MINT,
          owner: input.from,
          uiTokenAmount: {
            amount: input.fromPre,
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: SOLANA_USDC_MINT,
          owner: input.treasury,
          uiTokenAmount: {
            amount: input.treasuryPost,
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
        },
        {
          accountIndex: 2,
          mint: SOLANA_USDC_MINT,
          owner: input.from,
          uiTokenAmount: {
            amount: input.fromPost,
            decimals: 6,
            uiAmount: null,
            uiAmountString: "0",
          },
        },
      ],
      innerInstructions: null,
      logMessages: null,
      rewards: null,
      status: { Ok: null },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("extractDepositsByOwnerDelta", () => {
  it("prefers exact balance match attribution", () => {
    const deps = extractDepositsByOwnerDelta(
      fakeTx({
        sig: "sig1",
        treasury: TREASURY,
        from: SENDER,
        treasuryPre: "1000000",
        treasuryPost: "6000000",
        fromPre: "10000000",
        fromPost: "5000000",
      }),
      TREASURY,
    );
    expect(deps).toEqual([
      {
        signature: "sig1",
        fromWallet: SENDER,
        amountAtomic: 5_000_000,
        attribution: "balance_match",
      },
    ]);
  });

  it("returns empty when treasury did not gain USDC", () => {
    expect(
      extractDepositsByOwnerDelta(
        fakeTx({
          sig: "sig2",
          treasury: TREASURY,
          from: SENDER,
          treasuryPre: "5000000",
          treasuryPost: "5000000",
          fromPre: "10000000",
          fromPost: "9000000",
        }),
        TREASURY,
      ),
    ).toEqual([]);
  });
});

describe("extractDepositsFromSplTransfers", () => {
  it("attributes via transferChecked into treasury ATA", () => {
    const deps = extractDepositsFromSplTransfers(
      fakeTx({
        sig: "sig-spl",
        treasury: TREASURY,
        from: SENDER,
        treasuryPre: "0",
        treasuryPost: "5000000",
        fromPre: "5000000",
        fromPost: "0",
        spl: true,
      }),
      TREASURY,
    );
    expect(deps).toEqual([
      {
        signature: "sig-spl",
        fromWallet: SENDER,
        amountAtomic: 5_000_000,
        attribution: "spl_transfer",
      },
    ]);
  });
});

describe("extractDeposits", () => {
  it("prefers SPL over balance heuristics", () => {
    const deps = extractDeposits(
      fakeTx({
        sig: "sig-pref",
        treasury: TREASURY,
        from: SENDER,
        treasuryPre: "0",
        treasuryPost: "5000000",
        fromPre: "5000000",
        fromPost: "0",
        spl: true,
      }),
      TREASURY,
    );
    expect(deps[0]?.attribution).toBe("spl_transfer");
  });
});
