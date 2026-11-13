/**
 * Compilation state: identifier quoting, alias bindings, parameter collection and expression caching.
 */
import type {
  CommonTableExpression,
  MutationPlan,
  SelectPlan,
  TableBinding,
} from "../plan/types";
import type {
  PlaceholderNode,
  PredicateDescription,
  ScopePredicate,
  ValueNode,
} from "../expressions";
import type { PostgresRenderer, RenderContext } from "./postgres/types";

export type Bindings = Readonly<Record<string, TableBinding>>;
type ExpressionCache = {
  node: ValueNode;
  sql: string;
  jsonOutput: boolean;
}[];

/** Where one $scope() filter landed in a compiled statement. */
export type ScopeSlot = {
  readonly description: ScopePredicate;
  readonly bindings: Bindings;
  readonly aliases: ReadonlyMap<TableBinding, string>;
  /** Its parameters are `parameters[start..end)`. */
  readonly start: number;
  readonly end: number;
  readonly sql: string;
};

/** Everything one compilation shares between its render functions. */
export type Compilation = {
  readonly plan: SelectPlan | MutationPlan;
  readonly renderer: PostgresRenderer;
  readonly placeholder: ((node: PlaceholderNode) => unknown) | undefined;
  readonly parameters: unknown[];
  /** $scope() results to render instead of the ones from build time. */
  readonly scopeValues:
    | ReadonlyMap<ScopePredicate, PredicateDescription>
    | undefined;
  scopes: ScopeSlot[] | undefined;
  readonly commonTables: Map<string, CommonTableExpression>;
  readonly visiting: Set<object>;
  readonly references: Map<object, string>;
  // Temporary alias overrides for nested source occurrences.
  readonly aliasNames: Map<TableBinding, string>;
  expressionCaches: Map<Bindings, ExpressionCache> | undefined;
  aggregateReferences: Map<Bindings, Map<ValueNode, string>> | undefined;
  /** Recursion seam: values and predicates render subqueries through it. */
  readonly selectSql: (
    query: SelectPlan,
    outerBindings: Bindings,
    jsonValues?: boolean,
    jsonOutput?: boolean,
  ) => string;
};

export const createCompilation = (
  plan: SelectPlan | MutationPlan,
  renderer: PostgresRenderer,
  placeholder: ((node: PlaceholderNode) => unknown) | undefined,
  selectSql: Compilation["selectSql"],
  scopeValues?: Compilation["scopeValues"],
): Compilation => ({
  plan,
  renderer,
  placeholder,
  parameters: [],
  scopeValues,
  scopes: undefined,
  commonTables: new Map(),
  visiting: new Set(),
  references: new Map(),
  aliasNames: new Map(),
  expressionCaches: undefined,
  aggregateReferences: undefined,
  selectSql,
});

const quotedIdentifiers = new Map<string, string>();

export const quoteIdentifier = (identifier: string): string => {
  const cached = quotedIdentifiers.get(identifier);

  if (cached !== undefined) {
    return cached;
  }

  if (identifier.length <= 63 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    const quoted = `"${identifier}"`;

    // Schema names and aliases form a small set; user-supplied names stay bounded.
    if (quotedIdentifiers.size < 4096) {
      quotedIdentifiers.set(identifier, quoted);
    }

    return quoted;
  }

  if (!identifier.length || identifier.includes("\0")) {
    throw new Error(
      "symmetria: SQL identifiers must be nonempty and cannot contain null bytes",
    );
  }

  if (Buffer.byteLength(identifier) > 63) {
    throw new Error(
      `symmetria: PostgreSQL identifiers cannot exceed 63 bytes: "${identifier}" has ${Buffer.byteLength(identifier)}; shorten the table, column or index name`,
    );
  }

  return `"${identifier.replaceAll('"', '""')}"`;
};

export const aliasSql = (
  compilation: Compilation,
  binding: TableBinding,
): string =>
  quoteIdentifier(compilation.aliasNames.get(binding) ?? binding.alias);

export const parameter = (compilation: Compilation, value: unknown): string => {
  compilation.parameters.push(value);

  return compilation.renderer.placeholder(compilation.parameters.length);
};

export const nestedAlias = (
  compilation: Compilation,
  prefix: string,
  bindings: Bindings,
): string => {
  const occupied = new Set(
    Object.values(bindings).map(
      (binding) => compilation.aliasNames.get(binding) ?? binding.alias,
    ),
  );
  let name = prefix;

  while (occupied.has(name)) {
    name += "_";
  }

  return quoteIdentifier(name);
};

/** Services handed to renderer methods that render within the given bindings. */
export const renderContext = (
  compilation: Compilation,
  bindings: Bindings,
): RenderContext => ({
  parameter: (value) => parameter(compilation, value),
  nestedAlias: (prefix) => nestedAlias(compilation, prefix, bindings),
  quote: quoteIdentifier,
});
