import { expect, spyOn, test } from "bun:test";
import {
  createRowDecoder,
  type RuntimeCodec,
} from "../../../packages/runtime/src/query/codecs";

test("decoder factories are evicted without losing live decoders or mixing codecs", () => {
  const generated = spyOn(globalThis, "Function");
  const codec: RuntimeCodec = {
    encode: (value) => value,
    decode: (value) => BigInt(String(value)),
  };
  const selection = [{ outputName: "eviction-value", codec }];

  try {
    const original = createRowDecoder(selection);
    const firstSource = generated.mock.calls.at(-1)![1];
    const other = createRowDecoder([
      {
        outputName: "eviction-value",
        codec: { ...codec, decode: (value) => `other:${value}` },
      },
    ]);
    expect(
      generated.mock.calls.filter((call) => call[1] === firstSource),
    ).toHaveLength(1);
    expect(other({ "eviction-value": "42" })).toEqual({
      "eviction-value": "other:42",
    });

    for (let index = 0; index < 1024; index++) {
      const key = `dynamic-field-${index}`;
      expect(createRowDecoder([{ outputName: key }])({ [key]: index })).toEqual(
        { [key]: index },
      );
    }

    const recreated = createRowDecoder(selection);
    expect(
      generated.mock.calls.filter((call) => call[1] === firstSource),
    ).toHaveLength(2);

    for (const decode of [original, recreated]) {
      expect(decode({ "eviction-value": "9007199254740993" })).toEqual({
        "eviction-value": 9007199254740993n,
      });
      expect(decode({ "eviction-value": null })).toEqual({
        "eviction-value": null,
      });
    }
  } finally {
    generated.mockRestore();
  }
});
