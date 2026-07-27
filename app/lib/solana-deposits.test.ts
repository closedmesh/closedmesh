import { describe, expect, it } from "vitest";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { extractDepositsByOwnerDelta } from "./solana-deposits";
import { SOLANA_USDC_MINT } from "./solana-config";

function fakeTx(input: {
  sig: string;
  treasury: string;
  from: string;
  treasuryPre: string;
  treasuryPost: string;
  fromPre: string;
  fromPost: string;
}): ParsedTransactionWithMeta {
  return {
    transaction: {
      signatures: [input.sig],
      message: { accountKeys: [], instructions: [], recentBlockhash: "" },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [
        {
          accountIndex: 0,
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
          accountIndex: 1,
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
          accountIndex: 0,
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
          accountIndex: 1,
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
  it("detects a USDC top-up into the treasury", () => {
    const deps = extractDepositsByOwnerDelta(
      fakeTx({
        sig: "sig1",
        treasury: "Treasury1111111111111111111111111111111",
        from: "Sender111111111111111111111111111111111",
        treasuryPre: "1000000",
        treasuryPost: "6000000",
        fromPre: "10000000",
        fromPost: "5000000",
      }),
      "Treasury1111111111111111111111111111111",
    );
    expect(deps).toEqual([
      {
        signature: "sig1",
        fromWallet: "Sender111111111111111111111111111111111",
        amountAtomic: 5_000_000,
      },
    ]);
  });

  it("returns empty when treasury did not gain USDC", () => {
    expect(
      extractDepositsByOwnerDelta(
        fakeTx({
          sig: "sig2",
          treasury: "Treasury1111111111111111111111111111111",
          from: "Sender111111111111111111111111111111111",
          treasuryPre: "5000000",
          treasuryPost: "5000000",
          fromPre: "10000000",
          fromPost: "9000000",
        }),
        "Treasury1111111111111111111111111111111",
      ),
    ).toEqual([]);
  });
});
