import { describe } from "bun:test";
import { queryJsonSemanticsTests } from "../../support/query-json-semantics";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL JSON and alias semantics",
  () => queryJsonSemanticsTests("postgres"),
);
