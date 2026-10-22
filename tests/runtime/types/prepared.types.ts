// Compile-only API contracts: bun run test:types.
import { schema, prepare, int, text } from "../../../packages/runtime/src";

{
  const database = schema({ users: { id: int, name: text } });
  const lookup = prepare({ id: int }, (parameters) =>
    database.users((users) => ({
      name: users.name,
      $where: users.id.is(parameters.id),
    })),
  );
  // @ts-expect-error parameter names are checked
  lookup.execute({ identifier: 1 });
  // @ts-expect-error parameter values retain their declared types
  lookup.execute({ id: "1" });
  // @ts-expect-error bound parameters are required
  lookup.execute();
  prepare({ id: int }, (parameters) => {
    // @ts-expect-error parameter type must match the compared column
    database.users((users) => ({ $where: users.name.is(parameters.id) }));

    return database.users((users) => ({ id: users.id }));
  });
  // @ts-expect-error unselected query cannot be prepared
  database.users.prepare();
  prepare({ size: text }, (parameters) =>
    // @ts-expect-error LIMIT parameters must be numeric
    database.users((users) => ({ id: users.id, $limit: parameters.size })),
  );
}
