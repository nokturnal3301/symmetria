// Compile-only API contracts: bun run test:types.
import {
  schema,
  prepare,
  int,
  bigint,
  text,
  jsonb,
} from "../../../packages/runtime/src";

{
  const database = schema({ users: { id: int, name: text } });
  const lookup = prepare({ id: int }, (parameters) =>
    database.users(
      (users) => ({
        name: users.name,
      }),
      { where: (users) => users.id.is(parameters.id) },
    ),
  );
  // @ts-expect-error parameter names are checked
  lookup.execute({ identifier: 1 });
  // @ts-expect-error parameter values retain their declared types
  lookup.execute({ id: "1" });
  // @ts-expect-error bound parameters are required
  lookup.execute();
  prepare({ id: int }, (parameters) => {
    // @ts-expect-error parameter type must match the compared column
    database.users({ where: (users) => users.name.is(parameters.id) });

    return database.users((users) => ({ id: users.id }));
  });
  // @ts-expect-error unselected query cannot be prepared
  database.users.prepare();
  prepare({ size: text }, (parameters) =>
    // @ts-expect-error LIMIT parameters must be numeric
    database.users((users) => ({ id: users.id }), { limit: parameters.size }),
  );
}

{
  // A jsonb(schema) parameter stores the schema's input, so it can be written
  // into its own column; comparisons keep taking it.
  type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: readonly { readonly message: string }[] };
  const since = {
    "~standard": {
      version: 1 as const,
      vendor: "types",
      validate: (value: unknown): Result<{ since: Date }> => ({
        value: { since: new Date(String(value)) },
      }),
      types: undefined as unknown as {
        input: { since: string };
        output: { since: Date };
      },
    },
  };
  const database = schema({
    events: { id: int.auto, since: jsonb(since) },
    counters: { id: bigint.auto, views: bigint, owner: int },
  });

  prepare({ since: jsonb(since) }, (p) =>
    database.events.insert({ since: p.since }),
  );
  prepare({ id: int, since: jsonb(since) }, (p) =>
    database.events.byId(p.id).update({ since: p.since }),
  );
  prepare({ since: jsonb(since) }, (p) =>
    database.events((e) => ({ id: e.id }), {
      where: (e) => e.since.is(p.since),
    }),
  );
  prepare({ id: int }, (p) =>
    // @ts-expect-error a number is not the stored JSON
    database.events.byId(p.id).update({ since: p.id }),
  );

  // A bigint parameter takes a safe integer, as writes and filters do.
  const byViews = prepare({ views: bigint }, (p) =>
    database.counters((c) => ({ id: c.id }), {
      where: (c) => c.views.is(p.views),
    }),
  );
  byViews({ views: 5 });
  byViews({ views: 5n });
  // @ts-expect-error decimal text is not a bigint
  byViews({ views: "5" });
  // An int parameter compares with a bigint column and looks a bigint key up.
  prepare({ views: int }, (p) =>
    database.counters((c) => ({ id: c.id }), {
      where: (c) => c.views.atLeast(p.views),
    }),
  );
  prepare({ id: int }, (p) => database.counters.byId(p.id));
  prepare({ owner: bigint }, (p) =>
    database.counters((c) => ({ id: c.id }), {
      // @ts-expect-error a bigint does not narrow to an int column
      where: (c) => c.owner.is(p.owner),
    }),
  );
}
