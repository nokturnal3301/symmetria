// Compile-only API contracts: bun run test:types. A jsonb(schema) column stores
// the schema's input form: writes take the input type, reads return the output.
import {
  coalesce,
  int,
  jsonb,
  maximum,
  prepare,
  schema,
  table,
  type Infer,
  type InferInsert,
  type InferUpdate,
  type StandardInput,
  type StandardOutput,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <
    Value,
  >() => Value extends Expected ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

// The Standard Schema V1 shape of a transforming schema, as Zod publishes it.
interface TransformingSchema<Input, Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] };
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
}

declare const event: TransformingSchema<{ at: string }, { at: Date }>;
declare const counter: TransformingSchema<number, number>;
// A schema that declares no `types` falls back to its output for writes.
declare const untyped: {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: { n: number } };
  };
};

// Hand-written schemas: TypeScript widens the failure branch of `validate`
// with `value?: undefined`, which must not make the output optional.
const handWritten = {
  "~standard": {
    version: 1 as const,
    vendor: "app",
    validate: (value: unknown) =>
      typeof value === "number"
        ? { value: { n: value } }
        : { issues: [{ message: "expected a number" }] },
    types: undefined as unknown as { input: number; output: { n: number } },
  },
};
const handWrittenUntyped = {
  "~standard": {
    version: 1 as const,
    vendor: "app",
    validate: (value: unknown) =>
      typeof value === "string"
        ? { value: { label: value } }
        : { issues: [{ message: "expected a string" }] },
  },
};
type HandWrittenOutput = Assert<
  Equal<StandardOutput<typeof handWrittenUntyped>, { label: string }>
>;

const events = table({
  id: int.auto,
  payload: jsonb(event),
  previous: jsonb(event).nullable,
  count: jsonb(counter),
  legacy: jsonb(untyped),
  boxed: jsonb(handWritten),
});
const model = schema({ events });

type ReadPayload = Assert<
  Equal<Infer<typeof model.events>["payload"], { at: Date }>
>;
type WrittenPayload = Assert<
  Equal<InferInsert<typeof model.events>["payload"], { at: string }>
>;
type WrittenPrevious = Assert<
  Equal<
    InferInsert<typeof model.events>["previous"],
    { at: string } | null | undefined
  >
>;
type ReadPrevious = Assert<
  Equal<Infer<typeof model.events>["previous"], { at: Date } | null>
>;
type Untyped = Assert<
  Equal<InferInsert<typeof model.events>["legacy"], { n: number }>
>;
type Input = Assert<Equal<StandardInput<typeof event>, { at: string }>>;
type ReadBoxed = Assert<
  Equal<Infer<typeof model.events>["boxed"], { n: number }>
>;
type WrittenBoxed = Assert<
  Equal<InferInsert<typeof model.events>["boxed"], number>
>;
type StandaloneInsert = Assert<
  Equal<InferInsert<typeof events>["payload"], { at: string }>
>;
type StandaloneRow = Assert<
  Equal<Infer<typeof events>["payload"], { at: Date }>
>;
type UpdatePayload = Assert<
  Equal<
    Extract<InferUpdate<typeof model.events>["payload"], { at: unknown }>,
    { at: string }
  >
>;

model.events.insert({
  payload: { at: "2026-11-09T10:00:00Z" },
  count: 1,
  legacy: { n: 1 },
  boxed: 1,
});
model.events
  .insert({
    payload: { at: "2026-11-09" },
    count: 1,
    legacy: { n: 1 },
    boxed: 1,
  })
  .onConflict("id")
  .doUpdate({ payload: { at: "2026-11-10" } });
model.events.update({ payload: { at: "2026-11-09" } }).all();
model.events.insert({
  // @ts-expect-error writes take the schema's input, not the transformed output
  payload: { at: new Date() },
  count: 1,
  legacy: { n: 1 },
  boxed: 1,
});
// @ts-expect-error updates take the input form as well
model.events.update({ payload: { at: new Date() } }).all();

const rows = await model.events((event) => ({ payload: event.payload }));
type Rows = Assert<Equal<(typeof rows)[number]["payload"], { at: Date }>>;

// Filters, contains() and paths compare the stored JSON: the schema's input.
declare const audit: TransformingSchema<
  { at: string; tags: string[]; level: number },
  { at: Date; labels: Set<string>; level: number }
>;
const audits = table({
  id: int.auto,
  entry: jsonb(audit),
  previous: jsonb(audit).nullable,
  plain: jsonb<{ at: string }>(),
});
const audited = schema({ audits, events });
type AuditInput = { at: string; tags: string[]; level: number };
const entryInput: AuditInput = { at: "2026-11-09", tags: ["a"], level: 1 };
const entryOutput = {
  at: new Date(),
  labels: new Set(["a"]),
  level: 1,
};

audited.audits((audit) => ({ id: audit.id }), {
  where: (audit) => [
    audit.entry.is(entryInput),
    audit.entry.isNot(entryInput),
    audit.entry.in([entryInput]),
    audit.entry.notIn([entryInput]),
    audit.entry.isDistinctFrom(entryInput),
    audit.entry.between(entryInput, entryInput),
    audit.entry.contains({ tags: ["a"] }),
    audit.entry.is(audit.previous),
    audit.previous.is(null),
    audit.entry.path("at").is("2026-11-09"),
    audit.entry.path("tags", 0).like("a%"),
    audit.entry.path("tags").contains(["a"]),
    audit.entry.path("level").above(1),
    audit.plain.is({ at: "2026-11-09" }),
  ],
});
// @ts-expect-error filters take the stored input, not the transformed output
audited.audits((audit) => ({ x: audit.entry.is(entryOutput) }));
// @ts-expect-error in() as well
audited.audits((audit) => ({ x: audit.entry.in([entryOutput]) }));
// @ts-expect-error contains() compares the stored JSON
audited.audits((audit) => ({ x: audit.entry.contains({ at: new Date() }) }));
// @ts-expect-error paths follow the stored keys: labels exists only after the transform
audited.audits((audit) => ({ x: audit.entry.path("labels") }));
// @ts-expect-error path values are the stored values
audited.audits((audit) => ({ x: audit.entry.path("at").is(new Date()) }));

{
  // Selecting the column still reads the output; a path reads the stored JSON.
  const query = audited.audits((audit, { leftJoin }) => {
    const other = leftJoin(audited.audits.as("other"), (other) =>
      other.entry.is(audit.entry),
    );

    return {
      entry: audit.entry,
      at: audit.entry.path("at"),
      joined: other.entry,
      latest: maximum(audit.entry),
      fallback: coalesce(audit.previous, entryInput),
    };
  });
  type Row = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>[number],
      {
        entry: { at: Date; labels: Set<string>; level: number };
        at: string | null;
        joined: { at: Date; labels: Set<string>; level: number } | null;
        latest: { at: Date; labels: Set<string>; level: number } | null;
        fallback: { at: Date; labels: Set<string>; level: number };
      }
    >
  >;
  // @ts-expect-error coalesce() stores its fallback like a write: the input form
  audited.audits((audit) => ({ x: coalesce(audit.previous, entryOutput) }));

  // A joined (nullable) column, a CTE column and a prepared parameter compare the input too.
  audited.audits((audit, { leftJoin }) => {
    const other = leftJoin(audited.audits.as("other"), (other) =>
      other.entry.is(entryInput),
    );
    // @ts-expect-error
    other.entry.is(entryOutput);

    return { id: audit.id };
  });
  const recent = audited
    .audits((audit) => ({ id: audit.id, entry: audit.entry }))
    .cte("recent");
  recent((row) => ({ id: row.id }), {
    where: (row) => [row.entry.is(entryInput), row.entry.path("level").is(1)],
  });
  // @ts-expect-error
  recent((row) => ({ x: row.entry.is(entryOutput) }));
  // A prepared jsonb(schema) parameter is stored like a write: the input form.
  const byEntry = prepare({ entry: jsonb(audit) }, (parameters) =>
    audited.audits((audit) => ({ id: audit.id }), {
      where: (audit) => audit.entry.is(parameters.entry),
    }),
  );
  byEntry.execute({ entry: entryInput });
  // @ts-expect-error
  byEntry.execute({ entry: entryOutput });
}

// Traits stay inside query columns: rows read whole are the plain read rows.
const whole = await audited.audits.byId(1).one();
type Whole = Assert<Equal<typeof whole, Infer<typeof audited.audits>>>;
type WholeEntry = Assert<
  Equal<
    Infer<typeof audited.audits>["entry"],
    { at: Date; labels: Set<string>; level: number }
  >
>;
const returned = await audited.audits
  .insert({ entry: entryInput, previous: null, plain: { at: "x" } })
  .returning((audit) => audit);
type Returned = Assert<Equal<typeof returned, Infer<typeof audited.audits>>>;

// A nested result's JSON holds each jsonb(schema) field in its stored form: a
// path reads the field like the column (output) and compares its input, and a
// path inside the field reads the stored JSON.
{
  const journals = table({ id: int.auto, entry: jsonb(audit) });
  const lines = table({ id: int.auto, journal: journals });
  const journaled = schema({ journals, lines });
  type Output = { at: Date; labels: Set<string>; level: number };

  const related = journaled.lines((line) => {
    const journal = line.journal((journal) => ({ entry: journal.entry }));

    return {
      journal,
      entry: journal.path("entry"),
      at: journal.path("entry", "at"),
      matches: journal.path("entry").is(entryInput) && line.id,
    };
  });
  type Related = Assert<
    Equal<
      Awaited<ReturnType<typeof related.execute>>[number],
      {
        journal: { entry: Output } | null;
        entry: Output | null;
        at: string | null;
        matches: number;
      }
    >
  >;
  journaled.lines((line) => ({ id: line.id }), {
    where: (line) => [
      line
        .journal((journal) => ({ entry: journal.entry }))
        .is({
          entry: entryInput,
        }),
      line
        .journal((journal) => ({ entry: journal.entry }))
        .path("entry", "tags", 0)
        .is("a"),
    ],
  });
  journaled.lines((line) => {
    const journal = line.journal((j) => ({ entry: j.entry }));
    // @ts-expect-error the field compares its stored input, not the output
    journal.path("entry").is(entryOutput);
    // @ts-expect-error inside the field, paths follow the stored keys
    journal.path("entry", "labels");
    // @ts-expect-error the nested result compares its stored form
    journal.is({ entry: entryOutput });

    return { id: line.id };
  });

  // A collection, a CTE's nested object and a selected query field alike.
  const many = journaled.journals((journal) => ({
    at: journal
      .lines((line) => ({ id: line.id, entry: line.journal.entry }))
      .path(0, "id"),
  }));
  void many;
  const nested = journaled
    .journals((journal) => ({
      id: journal.id,
      payload: { entry: journal.entry, level: journal.entry.path("level") },
      listed: journaled.journals((other) => ({ entry: other.entry })),
    }))
    .cte("nested");
  const fromCte = nested((row) => ({
    entry: row.payload.path("entry"),
    at: row.payload.path("entry", "at"),
    first: row.listed.path(0, "entry", "at"),
    level: row.payload.path("level"),
  }));
  type FromCte = Assert<
    Equal<
      Awaited<ReturnType<typeof fromCte.execute>>[number],
      {
        entry: Output | null;
        at: string | null;
        first: string | null;
        level: number | null;
      }
    >
  >;
  nested((row) => ({ id: row.id }), {
    where: (row) => [
      row.payload.path("entry").is(entryInput),
      row.listed.path(0, "entry").is(entryInput),
    ],
  });
  // @ts-expect-error
  nested((row) => ({ x: row.payload.path("entry").is(entryOutput) }));
  // @ts-expect-error
  nested((row) => ({ x: row.listed.path(0, "entry", "labels") }));
}
