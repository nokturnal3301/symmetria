import { describe } from "bun:test";
import { scopedWriteTests } from "../../support/scoped-writes";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL $scope() writes stay inside the scope",
  () => scopedWriteTests(),
);
