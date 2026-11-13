import { describe } from "bun:test";
import { errorTimingTests } from "../../support/error-timing";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL data errors reject when the operation runs",
  () => errorTimingTests(),
);
