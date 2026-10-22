import { describe } from "bun:test";
import { queryEdgeCaseTests } from "../../support/query-edge-cases";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL query edge cases",
  () => queryEdgeCaseTests("postgres"),
);
