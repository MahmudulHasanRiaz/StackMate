/**
 * SHA-256 test vectors for the pure-TypeScript implementation in
 * packages/contracts/src/common/sha256.ts.
 *
 * Each expected digest is the canonical FIPS 180-4 / node:crypto value,
 * cross-checked here against node:crypto at runtime so a regression in the
 * hand-rolled implementation cannot pass silently. The vectors cover the
 * empty string, short ASCII, multi-block input, and non-ASCII (Bangla +
 * emoji) UTF-8 input.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "../../../packages/contracts/src/common/sha256.ts";

const VECTORS: Array<{ input: string; expected: string }> = [
  { input: "", expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { input: "abc", expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  {
    input: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    expected: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  },
  { input: "StackMate", expected: createHash("sha256").update("StackMate", "utf8").digest("hex") },
  {
    input: "নাশিদ — Nasheed 🎵 1234567890",
    expected: createHash("sha256").update("নাশিদ — Nasheed 🎵 1234567890", "utf8").digest("hex"),
  },
  {
    input: "x".repeat(1000),
    expected: createHash("sha256").update("x".repeat(1000), "utf8").digest("hex"),
  },
];

describe("pure-TypeScript SHA-256 (contracts/common/sha256)", () => {
  for (const { input, expected } of VECTORS) {
    it(`matches node:crypto for input of length ${input.length}`, () => {
      assert.equal(sha256Hex(input), expected);
    });
  }

  it("is deterministic and differs across inputs", () => {
    assert.equal(sha256Hex("a"), sha256Hex("a"));
    assert.notEqual(sha256Hex("a"), sha256Hex("b"));
  });
});
