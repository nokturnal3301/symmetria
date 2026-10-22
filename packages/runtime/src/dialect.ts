/** SQL dialect strategies for driver authors. */
export {
  postgresDialect,
  sqliteDialect,
  registerDialect,
  type DialectStrategy,
  type DialectCapabilities,
  type RenderContext,
} from "./query/dialects";
export type { Dialect } from "./query/state";
