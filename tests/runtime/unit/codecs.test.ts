import { expect, spyOn, test } from "bun:test";
import {
  arrayCodec,
  bigintCodec,
  bytesCodec,
  codecFor,
  createRowDecoder,
  numericCodec,
  type RuntimeCodec,
} from "../../../packages/runtime/src/query/codecs";
import { canonicalType } from "../../../packages/runtime/src/query/codecs/type-names";
import {
  customType,
  jsonb,
  COLUMN_CODEC,
} from "../../../packages/runtime/src/schema/column";

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

test("a box array reads and writes with PostgreSQL's ';' between elements", () => {
  const box: RuntimeCodec = {
    encode: (value) => value,
    decode: (value) => String(value),
  };
  const boxes = arrayCodec("box", box);

  // node-postgres hands over box[] as its text.
  expect(boxes.decode("{(1,1),(0,0);(3,4),(2,2)}")).toEqual([
    "(1,1),(0,0)",
    "(3,4),(2,2)",
  ]);
  expect(boxes.decode("{}")).toEqual([]);
  // The drivers would write it with commas, which PostgreSQL refuses.
  expect(boxes.encode(["(1,1),(0,0)", "(3,4),(2,2)"] as never)).toBe(
    '{"(1,1),(0,0)";"(3,4),(2,2)"}',
  );
  // Every other array keeps commas.
  expect(arrayCodec("point", box).decode('{"(1,1)","(2,2)"}')).toEqual([
    "(1,1)",
    "(2,2)",
  ]);
});

test("type names read in PostgreSQL's every spelling; the builders' own come back unchanged", () => {
  for (const [declared, canonical] of [
    ["int8", "bigint"],
    ["BIGINT", "bigint"],
    ["bigserial", "bigint"],
    ["pg_catalog.int8", "bigint"],
    ['"pg_catalog"."int8"', "bigint"],
    ["int8[]", "bigint[]"],
    ["int8 ARRAY", "bigint[]"],
    ["decimal(30,10)", "numeric(30,10)"],
    ["NUMERIC( 30 , 10 )", "numeric(30,10)"],
    ["Decimal", "numeric"],
    ["bool", "boolean"],
    ["BOOLEAN", "boolean"],
    ["UUID", "uuid"],
    ["int4", "integer"],
    ["float4", "real"],
    ["float(24)", "real"],
    ["float", "double precision"],
    ["DOUBLE  PRECISION", "double precision"],
    ["timestamp(3) with time zone", "timestamptz(3)"],
    ["TIMESTAMP WITHOUT TIME ZONE", "timestamp"],
    ["character varying(20)", "varchar(20)"],
    ["interval day to second(3)", "interval"],
    ["dec(30,10)", "numeric(30,10)"],
    ["DEC", "numeric"],
    ["_int8", "bigint[]"],
    ["pg_catalog._int8", "bigint[]"],
    ['"_int8"', "bigint[]"],
    ["_numeric", "numeric[]"],
    ["_bool", "boolean[]"],
    ["_uuid", "uuid[]"],
    ["_date", "date[]"],
    ["_timestamptz", "timestamptz[]"],
    ["_timestamp", "timestamp[]"],
    ["_time", "time[]"],
    ["_timetz", "timetz[]"],
    ["_interval", "interval[]"],
    ["_float8", "double precision[]"],
    ["time(3) with time zone", "timetz(3)"],
    ["char varying(5)", "varchar(5)"],
    ["bit varying(5)", "varbit(5)"],
    // A quoted name is exactly that name: "INT8" is not PostgreSQL's int8.
    ['"INT8"', "INT8"],
    ["amount", "amount"],
    // A domain's array type keeps its name.
    ["_amount", "_amount"],
  ]) {
    expect([declared, canonicalType(declared!)]).toEqual([declared, canonical]);
  }

  for (const builder of [
    "bigint",
    "integer",
    "smallint",
    "boolean",
    "uuid",
    "numeric",
    "numeric(12,2)",
    "real",
    "double precision",
    "timestamptz",
    "timestamptz(3)",
    "timestamp(6)",
    "date",
    "time",
    "interval",
    "bytea",
    "jsonb",
    "text",
    "varchar(255)",
    "vector(3)",
    "enum",
    "derived",
    "integer[]",
  ]) {
    expect(canonicalType(builder)).toBe(builder);
  }

  expect(codecFor("int8")).toBe(bigintCodec);
  expect(codecFor("DECIMAL")).toBe(numericCodec);
});

test("a bytea value owns its bytes, not a view into the driver's shared pool", () => {
  // Node's pool: one 8 KB slab holds other queries' SQL, parameters and rows.
  const pool = new Uint8Array(8192).fill(7);
  const view = pool.subarray(100, 103);
  const read = bytesCodec.decode(view) as Uint8Array;

  expect([...read]).toEqual([7, 7, 7]);
  expect(read.buffer.byteLength).toBe(3);
  expect(read.byteOffset).toBe(0);
  expect(Object.getPrototypeOf(read)).toBe(Uint8Array.prototype);
  pool.fill(9);
  expect([...read]).toEqual([7, 7, 7]);
  // Arrays of bytea read each element the same way.
  const [element] = arrayCodec("bytea", bytesCodec).decode([
    view,
  ]) as Uint8Array[];
  expect(element!.buffer.byteLength).toBe(3);
  // A value that has a buffer of its own is used as it is, without a copy.
  const own = new Uint8Array([1, 2, 3]);
  expect((bytesCodec.decode(own) as Uint8Array).buffer).toBe(own.buffer);
});

test("customType() with a base reads and writes as the base type, also under an application codec", () => {
  const codecOf = (column: unknown) =>
    (column as { [COLUMN_CODEC]: RuntimeCodec })[COLUMN_CODEC];
  const amount = codecOf(customType("amount", { base: "numeric(30,10)" }));

  expect(amount.base).toBe("numeric(30,10)");
  expect(amount.sqlType).toBe("amount");
  expect(amount.decode(1.5)).toBe("1.5");
  expect(() => amount.encode("abc" as never)).toThrow("numeric values");

  const at = codecOf(customType<Date>("moment", { base: "TIMESTAMPTZ" }));
  // A nested result holds the text, the top level a Date: both read as a Date.
  expect(at.decode("2026-01-02T03:04:05.678+00:00")).toEqual(
    new Date("2026-01-02T03:04:05.678Z"),
  );
  expect(at.decode(new Date(0))).toEqual(new Date(0));

  const cents = codecOf(
    customType<{ cents: bigint }>("money_cents", {
      base: "int8",
      encode: (value) => value.cents,
      decode: (value) => ({ cents: value as bigint }),
    }),
  );
  expect(cents.base).toBe("bigint");
  // decode receives the base type's value, as both drivers and JSON give it.
  expect(cents.decode("9007199254740993")).toEqual({
    cents: 9007199254740993n,
  });
  expect(cents.decode(9007199254740993n)).toEqual({ cents: 9007199254740993n });
  expect(cents.encode({ cents: 5n } as never)).toBe("5");

  const passthrough = codecOf(customType("citext_domain", { base: "citext" }));
  expect(passthrough.passthrough).toBe(true);

  expect(() => customType("amount", { base: "" })).toThrow(
    'customType("amount") base must be a SQL type name',
  );
  expect(() =>
    customType("amount", {
      base: "numeric",
      encode: (value: string) => value,
    } as never),
  ).toThrow("takes encode and decode together");
});

test("an array that arrives as text reads each element from its text form", () => {
  const codecOf = (column: unknown) =>
    (column as { [COLUMN_CODEC]: RuntimeCodec })[COLUMN_CODEC];
  // A domain's array has a type of its own: both drivers deliver PostgreSQL's text.
  const flags = codecOf(customType<boolean>("flag", { base: "bool" }).array);
  const docs = codecOf(customType<unknown>("doc", { base: "jsonb" }).array);
  const days = codecOf(
    customType<Date>("moment", { base: "timestamptz" }).array,
  );

  expect(flags.decode("{t,f}")).toEqual([true, false]);
  expect(flags.decode([true, false])).toEqual([true, false]);
  expect(flags.decode("[true,false]")).toEqual([true, false]);
  expect(
    docs.decode('{"{\\"k\\": [1, true]}","\\"text\\"",null,NULL}'),
  ).toEqual([{ k: [1, true] }, "text", null, null]);
  expect(docs.decode('[{"k":[1,true]}]')).toEqual([{ k: [1, true] }]);
  expect(days.decode('{"2026-01-02 03:04:05+00"}')).toEqual([
    new Date("2026-01-02T03:04:05Z"),
  ]);
  // Element texts of other types are read by their codecs as they are.
  expect(
    arrayCodec("bigint", bigintCodec).decode("{9007199254740993}"),
  ).toEqual([9007199254740993n]);
});

test("an array of more than one dimension is refused however it arrives", () => {
  const codecOf = (column: unknown) =>
    (column as { [COLUMN_CODEC]: RuntimeCodec })[COLUMN_CODEC];
  const refusal = "symmetria: multidimensional arrays are not supported";

  // A driver and JSON hand over the second dimension as arrays, which the
  // element codecs would read as values: Number([1, 2]) is NaN.
  for (const type of [
    "integer",
    "bigint",
    "numeric",
    "real",
    "double precision",
    "text",
    "boolean",
    "date",
    "timestamptz",
    "uuid",
    "bytea",
    "int4range",
  ]) {
    const codec = codecFor(`${type}[]`)!;

    expect(() =>
      codec.decode([
        ["1", "2"],
        ["3", "4"],
      ]),
    ).toThrow(refusal);
    expect(() => codec.decode('[["1","2"],["3","4"]]')).toThrow(refusal);
    expect(() => codec.decode("{{1,2},{3,4}}")).toThrow(refusal);
    expect(() => codec.decode("[1:2][1:2]={{1,2},{3,4}}")).toThrow(refusal);
  }

  // A domain is its base type, and a customType() over a built-in type
  // receives that type's values, whatever it makes of them.
  const amounts = codecOf(
    customType<string>("amount", { base: "numeric(30,10)" }).array,
  );
  const spans = codecOf(
    customType<[number, number]>("int4range", {
      encode: ([from, to]) => `[${from},${to})`,
      decode: (value) =>
        String(value).slice(1, -1).split(",").map(Number) as [number, number],
    }).array,
  );

  expect(() => amounts.decode([["1.5"], ["2.5"]])).toThrow(refusal);
  expect(() => spans.decode([["[1,5)"], ["[2,3)"]])).toThrow(refusal);
  expect(spans.decode(["[1,5)", "[2,3)"])).toEqual([
    [1, 5],
    [2, 3],
  ]);
  expect(spans.decode('{"[1,5)","[2,3)"}')).toEqual([
    [1, 5],
    [2, 3],
  ]);

  // Bun's typed arrays are one dimension of numbers; inside an array they
  // would be a second one. A bytea element is its bytes.
  expect(codecFor("integer[]")!.decode(new Int32Array([1, 2]))).toEqual([1, 2]);
  expect(codecFor("real[]")!.decode(new Float32Array([1.5, 2.5]))).toEqual([
    1.5, 2.5,
  ]);
  expect(() => codecFor("integer[]")!.decode([new Int32Array([1, 2])])).toThrow(
    refusal,
  );
  expect(
    codecFor("bytea[]")!.decode([new Uint8Array([1]), Buffer.from([2, 3])]),
  ).toEqual([new Uint8Array([1]), new Uint8Array([2, 3])]);

  // A JSON element may be an array, and so may the element of a type known
  // by its name alone: a domain over jsonb or over an array, whose values a
  // nested result holds as JSON.
  expect(codecFor("jsonb[]")!.decode([[1, 2], [3]])).toEqual([[1, 2], [3]]);
  expect(
    codecOf(customType<unknown>("doc", { base: "jsonb" }).array).decode([
      [1, 2],
      { a: [3] },
    ]),
  ).toEqual([[1, 2], { a: [3] }]);
  expect(
    codecOf(
      customType<number[]>("pair", {
        encode: (value) => `{${value.join(",")}}`,
        decode: (value) =>
          Array.isArray(value)
            ? value.map(Number)
            : String(value).slice(1, -1).split(",").map(Number),
      }).array,
    ).decode([
      [1, 2],
      [3, 4],
    ]),
  ).toEqual([
    [1, 2],
    [3, 4],
  ]);
  expect(
    codecOf(customType<number[]>("pair", { base: "integer[]" }).array).decode([
      [1, 2],
      [3, 4],
    ]),
  ).toEqual([
    [1, 2],
    [3, 4],
  ]);
});

test("a json value refuses NaN and Infinity at any depth instead of writing null", () => {
  const json = codecFor("jsonb")!.encode as (value: unknown) => unknown;
  const list = codecFor("jsonb[]")!.encode as (value: unknown) => unknown;
  const message = /json or jsonb value cannot hold NaN or Infinity/;

  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    expect(() => json(bad)).toThrow(message);
    expect(() => json({ a: [1, { b: bad }] })).toThrow('(at "b")');
    expect(() => json([null, bad])).toThrow('(at "1")');
    expect(() => json({ toJSON: () => bad })).toThrow(message);
    // A Date that writes something else than its text is read like any toJSON().
    class Stamp extends Date {
      override toJSON() {
        return bad as never;
      }
    }
    expect(() => json({ at: new Stamp(0) })).toThrow('(at "at")');
    expect(() =>
      json({ a: Object.assign([1], { toJSON: () => [bad] }) }),
    ).toThrow(message);
    expect(() => json({ a: new Number(bad) })).toThrow(message);
    expect(() => json(new Float64Array([1, bad]))).toThrow(message);
    expect(() => list([{ a: bad }])).toThrow(message);
    // A nested toJSON() is called with its key, as JSON.stringify calls it.
    const keyed = { toJSON: (key: string) => (key === "a" ? bad : 0) };
    expect(() => json({ a: keyed })).toThrow('(at "a")');
    expect(() => json([keyed, { a: keyed }])).toThrow('(at "a")');
    expect(json({ b: keyed, c: null })).toBe('{"b":0,"c":null}');
  }

  // One toJSON() call writes the text, one more checks a text with a null.
  let calls = 0;
  const counted = {
    toJSON: () => {
      calls += 1;
      return 1;
    },
  };
  expect(json({ a: null, b: counted })).toBe('{"a":null,"b":1}');
  expect(calls).toBe(2);

  // A jsonb(schema) column too, whatever its schema accepts.
  const validated = jsonb({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
    },
  })[COLUMN_CODEC]!.encode as (value: unknown) => unknown;
  expect(() => validated({ a: Infinity })).toThrow(message);

  // Nulls, strings that spell them, dates and skipped values still encode.
  expect(
    json({
      a: null,
      b: "NaN",
      c: "null",
      d: new Date(0),
      e: undefined,
      f: [undefined, 1.5],
    }),
  ).toBe(
    '{"a":null,"b":"NaN","c":"null","d":"1970-01-01T00:00:00.000Z","f":[null,1.5]}',
  );
});
