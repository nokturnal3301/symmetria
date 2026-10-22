import { describe } from "bun:test";
import { queryBoundaryTests } from "../../support/query-boundaries";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL query boundaries",
  () => queryBoundaryTests("postgres"),
);
