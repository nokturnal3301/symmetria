import { describe } from "bun:test";
import { queryCompositionTests } from "../../support/query-composition";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL query composition",
  () => queryCompositionTests("postgres"),
);
