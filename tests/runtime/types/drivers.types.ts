// Compile-only API contracts: bun run test:types.
import type { PoolConfig } from "pg";
import {
  postgres,
  type PostgresOptions,
} from "../../../packages/runtime/src/entries/pg";
import {
  databaseError,
  type DatabaseErrorKind,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <
    Value,
  >() => Value extends Expected ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

// The adapter declares node-postgres's pool options itself, so its published
// types need no @types/pg, and a pg.PoolConfig still fits.
const config: PoolConfig = {
  host: "localhost",
  max: 4,
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: null,
  onConnect: async (client) => {
    await client.query("SET application_name = 'app'");
  },
};
postgres(config);
postgres({
  url: "postgres://localhost/app",
  max: 2,
  ssl: true,
  statement_timeout: false,
  password: async () => "secret",
  options: "-c search_path=app",
});
const options: PostgresOptions = { connectionString: "postgres://localhost" };
postgres(options);
// @ts-expect-error a misspelled option is not silently ignored
postgres({ url: "postgres://localhost/app", maxConnections: 2 });
// @ts-expect-error the adapter installs its own type parsers
postgres({ url: "postgres://localhost/app", types: config.types });

const kind = databaseError(new Error("Connection terminated"))?.kind;
type ConnectionKind = Assert<
  Equal<Extract<DatabaseErrorKind, "connection">, "connection">
>;
type Kind = Assert<Equal<typeof kind, DatabaseErrorKind | undefined>>;
