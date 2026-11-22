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

test("nested objects come back in the selected key order, built as json or as jsonb", async () => {
  const { jsonRowCodec } = await import(
    "../../../packages/runtime/src/query/codecs/json"
  );
  const codec = jsonRowCodec([
    { outputName: "firstName" },
    { outputName: "city" },
  ]);
  // json keeps the order it was built in; the same row is returned as it is.
  const asJson = { firstName: "Ada", city: "London" };

  expect(codec.decode(asJson)).toBe(asJson);
  // jsonb sorts keys by length, then by bytes.
  expect(
    Object.keys(codec.decode({ city: "London", firstName: "Ada" }) as object),
  ).toEqual(["firstName", "city"]);

  // A selection already in jsonb's order needs no check at all.
  expect(
    jsonRowCodec([{ outputName: "a" }, { outputName: "bb" }]).passthrough,
  ).toBe(true);
  // Nested deeper, the outer row follows the inner one.
  const outer = jsonRowCodec([
    { outputName: "who", codec },
    { outputName: "id" },
  ]);

  expect(
    outer.decode({ id: 1, who: { city: "London", firstName: "Ada" } }),
  ).toEqual({ who: { firstName: "Ada", city: "London" }, id: 1 });
  expect(
    Object.keys(
      (
        outer.decode({ id: 1, who: { city: "London", firstName: "Ada" } }) as {
          who: object;
        }
      ).who,
    ),
  ).toEqual(["firstName", "city"]);
});
