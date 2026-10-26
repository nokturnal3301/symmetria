import type {
  CommonTableExpression,
  MutationPlan,
  SelectPlan,
  TableBinding,
} from "../state";
import type { PlaceholderNode, ValueNode } from "../expressions";
import type { DialectStrategy, RenderContext } from "../dialects/types";

export type Bindings = Readonly<Record<string, TableBinding>>;
export type ExpressionCache = {
  node: ValueNode;
  sql: string;
  jsonOutput: boolean;
}[];

/** Everything one compilation shares between its render functions. */
export type Compilation = {
  readonly plan: SelectPlan | MutationPlan;
  readonly dialect: DialectStrategy;
  readonly placeholder: ((node: PlaceholderNode) => unknown) | undefined;
  readonly parameters: unknown[];
  readonly commonTables: Map<string, CommonTableExpression>;
  readonly visiting: Set<object>;
  readonly references: Map<object, string>;
  // SQLite resolves RETURNING against the table name, not a mutation alias.
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
  dialect: DialectStrategy,
  placeholder: ((node: PlaceholderNode) => unknown) | undefined,
  selectSql: Compilation["selectSql"],
): Compilation => ({
  plan,
  dialect,
  placeholder,
  parameters: [],
  commonTables: new Map(),
  visiting: new Set(),
  references: new Map(),
  aliasNames: new Map(),
  expressionCaches: undefined,
  aggregateReferences: undefined,
  selectSql,
});

export const quoteIdentifier = (identifier: string): string => {
  if (identifier.length <= 63 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return `"${identifier}"`;
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

  return compilation.dialect.placeholder(compilation.parameters.length);
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

/** Services handed to dialect methods that render within the given bindings. */
export const renderContext = (
  compilation: Compilation,
  bindings: Bindings,
): RenderContext => ({
  parameter: (value) => parameter(compilation, value),
  nestedAlias: (prefix) => nestedAlias(compilation, prefix, bindings),
  quote: quoteIdentifier,
});
