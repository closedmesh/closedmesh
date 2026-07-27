import { describe, expect, it } from "vitest";
import {
  estimateCompletionTokensFromText,
  extractDeltaContent,
} from "./stream-usage";

describe("estimateCompletionTokensFromText", () => {
  it("returns 0 for empty", () => {
    expect(estimateCompletionTokensFromText("")).toBe(0);
  });

  it("ceil-divides by 4", () => {
    expect(estimateCompletionTokensFromText("abcd")).toBe(1);
    expect(estimateCompletionTokensFromText("abcde")).toBe(2);
  });
});

describe("extractDeltaContent", () => {
  it("reads OpenAI-style delta content", () => {
    expect(
      extractDeltaContent(
        JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
      ),
    ).toBe("hi");
  });
});
