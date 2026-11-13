/** Private integration bridge for the matching symmetria-kit release. */
export { quoteIdentifier } from "../query/compile";
export { normalizeResult } from "../query/plan/types";
export { postgresArrayLiteral } from "../query/compile/postgres/values";
export { indexClausesSQL, INDEX_METHODS } from "../schema/indexes";
export { objectName } from "../schema/naming";
export {
  IDENTITY_ALWAYS,
  IDENTITY_BY_DEFAULT,
  isIdentityDefault,
} from "../schema/column";
export type { QueryInspectionController } from "../observability/inspection";
