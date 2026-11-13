import { describe } from "bun:test";
import { queryCorrectnessTests } from "../../support/query-correctness";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL results that used to be silently wrong",
  () => queryCorrectnessTests(),
);
