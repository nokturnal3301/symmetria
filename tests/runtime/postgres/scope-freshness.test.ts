import { describe } from "bun:test";
import { scopeFreshnessTests } from "../../support/scope-freshness";

describe.skipIf(!process.env.SYMMETRIA_TEST_DATABASE_URL)(
  "PostgreSQL $scope() values at execution",
  () => scopeFreshnessTests(),
);
