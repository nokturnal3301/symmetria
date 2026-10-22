import { describe } from "bun:test";
import { queryValueTests } from "../../support/query-values";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL value composition",
  () => queryValueTests("postgres"),
);
