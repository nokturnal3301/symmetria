import { describe } from "bun:test";
import { querySemanticsTests } from "../../support/query-semantics";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL mutation and NULL semantics",
  () => querySemanticsTests("postgres"),
);
