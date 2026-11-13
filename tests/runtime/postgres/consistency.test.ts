import { describe } from "bun:test";
import { queryConsistencyTests } from "../../support/query-consistency";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL results match their static types",
  () => queryConsistencyTests(),
);
