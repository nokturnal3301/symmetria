/**
 * Table mutation builders: insert, update, delete and upsert with RETURNING; whole-table UPDATE/DELETE
 * must be confirmed with all(), and so must one whose filter holds for every row (truth() and the
 * checks around it). A scoped database's writes check every written row against the scope.
 */
import { isDeepStrictEqual } from "node:util";
import { freeze } from "../plan/freeze";
import { childNodes } from "../plan/traverse";
import { sameExpression } from "../plan/equivalence";
import { expressionSqlType } from "../plan/metadata";
import { embeddingColumns } from "../../schema/search-columns";
import { scopeViolation, sqlState } from "../../driver/errors";
import {
  collectDataErrors,
  dataError,
  throwDataErrors,
} from "../codecs/deferred";
import { encodeValue } from "../codecs";
import type { PredicateList } from "../select/types";
import {
  duplicateKeyError,
  duplicateKeyProbe,
  rejectDuplicateKeys,
} from "./conflict-keys";
import type { MutationOptions } from "./types";
import {
  compilePlan,
  compileQuery,
  executePlan,
  executeCompiled,
} from "../compile";
import { executorProfiling } from "../../observability/profiling";
import { returningProjection, returningSelector } from "../select/projections";
import { shapeFrame, validatePredicate } from "../select/scope";
import { columnsOnly } from "../select/suggest";
import {
  PREPARE_QUERY,
  preparePlan,
  type PreparedKind,
  type PreparedQuery,
} from "../select/prepared";
import { writeKeySubqueries } from "../compile/select";
import {
  and,
  COLUMN_EXPRESSION,
  readPredicate,
  valueNode,
  jsonNullNode,
  type PlaceholderNode,
  type Predicate,
  type PredicateDescription,
  type ValueNode,
} from "../expressions";
import {
  primaryKeyColumns,
  uniqueColumnIndexes,
  type ColumnSnapshot,
} from "../../schema/assembly";
import {
  createScope,
  initialPlan,
  readSelection,
  type RuntimeScope,
} from "../select";
import {
  DEFAULT_VALUE,
  WRITE_TAG,
  normalizeResult,
  type CompiledQuery,
  type MutationPlan,
  type QueryExecutor,
  type SelectPlan,
  type TableBinding,
} from "../plan/types";

/** PostgreSQL's wire-protocol bind-parameter limit; larger multi-row INSERTs are split into atomic chunks. */
const PARAMETER_LIMIT = 65535;

/** A JS null stored as JSON null; a jsonb(schema) that rejects null makes it a data error. */
const jsonNullValue = (
  codec: TableBinding["codecs"][string] | undefined,
  sqlType: string,
): ValueNode => {
  try {
    return jsonNullNode(codec, sqlType);
  } catch (error) {
    dataError(error);

    return valueNode(null);
  }
};

/** TRUE, FALSE or NULL for every row whatever the data; undefined when it depends on the data. */
type Truth = boolean | null | undefined;

/**
 * The value a prepared parameter binds at one execution, encoded as a literal
 * of the same value would be; undefined when it is not known.
 */
export type BoundValue = (
  node: PlaceholderNode,
) => { readonly value: unknown } | undefined;

type GroupDescription = Extract<PredicateDescription, { kind: "group" }>;

/**
 * What the terms of an AND or OR say together when their values are never
 * NULL: conditions it holds with both signs (P and NOT P), and operands whose
 * ranges cover every value (`id >= 5 OR id < 6`) or, in an AND, none.
 */
type Opposition = {
  readonly pairs: readonly PredicateDescription[];
  readonly ranges: readonly ValueNode[];
  /**
   * A pair that decides the group even where its values are NULL: one of
   * them is `IS DISTINCT FROM` a value (TRUE there) in an OR, or `IS NOT
   * DISTINCT FROM` one (FALSE there) in an AND.
   */
  readonly certain?: true;
};

/** What the analysis of a condition knows besides the condition itself. */
type Analysis = {
  /**
   * Bindings whose rows are never NULL-extended: the written table and the
   * roots of the subqueries the condition sits in.
   */
  readonly roots: readonly TableBinding[];
  readonly bound?: BoundValue;
  /** Values taken to be NULL (true) or not (false) while each case is tried. */
  readonly assumed?: readonly (readonly [ValueNode, boolean])[];
  /**
   * A `$scope()` filter: an emptied list (`notIn([])`, `contains([])`) is the
   * condition it asks for, as an empty denylist admits every row on purpose.
   */
  readonly scope?: true;
  /** The oppositions bound values decide, found once for all the cases tried. */
  readonly oppositions?: Map<GroupDescription, Opposition>;
  /**
   * Comparisons of a prepared write that no bound value decides anything
   * for (see `inertLeaves()`): read as unknown without binding them.
   */
  readonly inert?: ReadonlySet<PredicateDescription>;
  /** A prepared write's groups, split once into what bound values decide and the rest. */
  readonly residuals?: Residuals;
};

/**
 * A group of a prepared write's filter, split at its first analysis: the
 * answer of the children no bound value changes, the values each of them
 * tests for NULL (by position), and the children each execution's values
 * decide (their entry in `tested` is undefined).
 */
type Residual = {
  readonly fixed: Truth;
  readonly tested: readonly (readonly ValueNode[] | undefined)[];
  readonly live: readonly PredicateDescription[];
};

/**
 * A prepared write's groups split, each once per place: where its children
 * sit among the terms of a searched group and which answer helps (see
 * evaluate() and ANY_SENSE), as both decide which nested groups are searched,
 * and so the answers of the children no bound value changes.
 */
type Residuals = Map<GroupDescription, (Residual | undefined)[]>;

/** Kleene AND: FALSE wins, then an unknown, then NULL. */
const allOf = (values: readonly Truth[]): Truth =>
  values.includes(false)
    ? false
    : values.includes(undefined)
      ? undefined
      : values.includes(null)
        ? null
        : true;

/** Kleene OR: TRUE wins, then an unknown, then NULL. */
const anyOf = (values: readonly Truth[]): Truth =>
  values.includes(true)
    ? true
    : values.includes(undefined)
      ? undefined
      : values.includes(null)
        ? null
        : false;

/**
 * Kleene AND or OR of values added one at a time: the value that wins (FALSE
 * or TRUE), then an unknown, then NULL.
 */
const combined = (
  operator: GroupDescription["operator"],
  current: Truth,
  value: Truth,
): Truth => {
  const wins = operator === "OR";

  return current === wins || value === wins
    ? wins
    : current === undefined || value === undefined
      ? undefined
      : current === null || value === null
        ? null
        : !wins;
};

const negated = (value: Truth): Truth =>
  value === undefined || value === null ? value : !value;

/** No row passes: FALSE and NULL both filter every row out. */
const never = (
  description: PredicateDescription,
  analysis: Analysis,
): boolean => {
  const value = analyse(description, analysis, false);

  return value === false || value === null;
};

/** An aggregate that collapses the rows into one, not one under a window. */
const aggregates = (node: ValueNode): boolean =>
  node.kind === "aggregate" ||
  (node.kind !== "window" && childNodes(node).some(aggregates));

/** Aggregates without grouping: one row even over no rows. */
const collapsed = (query: SelectPlan): boolean =>
  !query.grouping.length &&
  query.selection.some((expression) => aggregates(expression.node));

/** A LIMIT or OFFSET as a number: undefined when absent, NaN for a parameter of unknown value. */
const amount = (
  value: number | PlaceholderNode | undefined,
  analysis: Analysis,
): number | undefined => {
  if (value === undefined || typeof value === "number") {
    return value;
  }

  const bound = analysis.bound?.(value)?.value;

  return typeof bound === "number" ? bound : Number.NaN;
};

/**
 * The analysis of a subquery's own conditions: the rows of its root are not
 * NULL-extended either, unless a RIGHT or FULL join extends them. The cases
 * tried for values outside it say nothing about its rows, and a prepared
 * write's inert comparisons and residuals are those of the outer filter.
 */
const inside = (query: SelectPlan, analysis: Analysis): Analysis => {
  const { root } = query;
  const plain =
    !query.rootless &&
    !root.derived &&
    !root.cte &&
    !root.cteReference &&
    !root.projection &&
    !query.joins.some((join) => join.kind === "RIGHT" || join.kind === "FULL");

  return {
    roots: plain ? [...analysis.roots, root] : analysis.roots,
    ...(analysis.bound ? { bound: analysis.bound } : {}),
    ...(analysis.scope ? { scope: true as const } : {}),
    ...(analysis.oppositions ? { oppositions: analysis.oppositions } : {}),
  };
};

/**
 * A subquery that returns no row whatever the data: `EXISTS` of it is false
 * and `IN` it is false. A filter no row passes still leaves the one row of an
 * aggregate without grouping (`count()` is 0).
 */
const empty = (query: SelectPlan, analysis: Analysis): boolean => {
  const within = inside(query, analysis);

  return (
    amount(query.limit, analysis) === 0 ||
    query.having.some((description) => never(description, within)) ||
    (query.predicates.some((description) => never(description, within)) &&
      !collapsed(query))
  );
};

/** A subquery that returns exactly one row whatever the data: an aggregate without grouping. */
const single = (query: SelectPlan, analysis: Analysis): boolean => {
  const limit = amount(query.limit, analysis);
  const offset = amount(query.offset, analysis);

  return (
    collapsed(query) &&
    !query.having.length &&
    (limit === undefined || limit > 0) &&
    (offset === undefined || offset === 0)
  );
};

/**
 * What a node is for every row: a known value; a count, an integer of at
 * least 0 that is never NULL; or present, never NULL.
 */
type Known =
  | { readonly value: unknown }
  | { readonly count: true }
  | { readonly present: true };

/** The same value: one node, one column of one binding, or nodes of the same shape. */
const sameValue = (first: ValueNode, second: ValueNode): boolean =>
  first === second ||
  (first.kind === "column" && second.kind === "column"
    ? first.description.binding === second.description.binding &&
      first.description.column === second.description.column
    : first.kind === second.kind &&
      first.kind !== "parameter" &&
      first.kind !== "placeholder" &&
      sameExpression(first, second));

/** The text JSON null binds as, in a jsonb literal or parameter. */
const isJsonNullText = (value: unknown): boolean =>
  typeof value === "string" && value.trim() === "null";

/** The value `(value)::type` casts, as castNode() writes it; undefined otherwise. */
const castInner = (node: ValueNode, type: string): ValueNode | undefined =>
  node.kind === "raw" &&
  node.parts.length === 3 &&
  node.parts[0] === "(" &&
  node.parts[2] === `)::${type}` &&
  typeof node.parts[1] === "object"
    ? node.parts[1]
    : undefined;

/**
 * The operand of `NULLIF(operand, 'null'::jsonb)`, which reads JSON null as
 * SQL NULL (a json operand through its cast to jsonb); undefined otherwise.
 */
const jsonNullInner = (node: ValueNode): ValueNode | undefined => {
  if (node.kind !== "raw" || node.parts.length !== 3) {
    return undefined;
  }

  const [open, inner, close] = node.parts;

  if (typeof inner !== "object") {
    return undefined;
  }

  if (open === "NULLIF((" && close === ")::jsonb, 'null'::jsonb)") {
    return inner;
  }

  return open === "NULLIF(" && close === ", 'null'::jsonb)"
    ? (castInner(inner, "jsonb") ?? inner)
    : undefined;
};

const known = (node: ValueNode, analysis: Analysis): Known | undefined => {
  const { assumed } = analysis;

  if (assumed) {
    for (let index = 0; index < assumed.length; index += 1) {
      const [value, isNull] = assumed[index]!;

      if (sameValue(value, node)) {
        return isNull ? { value: null } : { present: true };
      }
    }
  }

  switch (node.kind) {
    case "parameter":
      return { value: node.value };
    case "placeholder":
      return analysis.bound?.(node);
    case "column":
      // A NOT NULL column of the written table or of a subquery's root: its
      // rows are never outer-joined.
      return analysis.roots.includes(node.description.binding) &&
        !node.description.binding.projection &&
        node.description.column.notNull
        ? { present: true }
        : undefined;
    case "arrayLength": {
      // cardinality() of an array: a whole number of at least 0, NULL only
      // for a NULL array.
      const value = node.json ? undefined : known(node.value, analysis);

      return !value
        ? undefined
        : "value" in value && value.value === null
          ? { value: null }
          : { count: true };
    }
    case "rowCount":
      return empty(node.query, analysis) ? { value: 0 } : { count: true };
    case "subquery": {
      const { query } = node;

      // A scalar subquery without a row is NULL.
      if (empty(query, analysis)) {
        return { value: null };
      }

      const selected = query.selection[0]?.node;

      if (
        query.selection.length !== 1 ||
        selected?.kind !== "aggregate" ||
        query.grouping.length
      ) {
        return undefined;
      }

      const within = inside(query, analysis);

      // One row over no rows: COUNT is 0, every other aggregate NULL.
      if (query.predicates.some((description) => never(description, within))) {
        return { value: selected.name === "COUNT" ? 0 : null };
      }

      return selected.name === "COUNT" && single(query, analysis)
        ? { count: true }
        : undefined;
    }
    case "raw": {
      // NULLIF(value, 'null'::jsonb): NULL where the value is JSON null, the
      // value otherwise.
      const json = jsonNullInner(node);

      if (json) {
        const value = known(json, analysis);

        return !value || !("value" in value)
          ? undefined
          : isJsonNullText(value.value)
            ? { value: null }
            : value;
      }

      // A value cast to text is NULL only where the value is.
      const cast = castInner(node, "text");

      if (cast) {
        const value = known(cast, analysis);

        return !value
          ? undefined
          : "value" in value && value.value === null
            ? { value: null }
            : { present: true };
      }

      // A relation's exists(): `EXISTS (subquery)`.
      const [text, subquery] = node.parts;

      if (
        !node.composed ||
        node.parts.length !== 2 ||
        text !== "EXISTS " ||
        typeof subquery !== "object" ||
        subquery.kind !== "subquery"
      ) {
        return undefined;
      }

      return empty(subquery.query, analysis)
        ? { value: false }
        : single(subquery.query, analysis)
          ? { value: true }
          : undefined;
    }
    case "coalesce": {
      // The first value that is not NULL; after one that may be NULL, a value
      // that never is still makes the whole never NULL.
      let unknown = false;

      for (const value of node.values) {
        const entry = known(value, analysis);

        if (!entry) {
          unknown = true;
        } else if (!("value" in entry) || entry.value !== null) {
          return unknown ? { present: true } : entry;
        }
      }

      return unknown ? undefined : { value: null };
    }
    default:
      return undefined;
  }
};

/** `TRUE`, which sql<boolean>`…` is compared with as a condition. */
const isTrueLiteral = (node: ValueNode): boolean =>
  node.kind === "raw" && node.parts.length === 1 && node.parts[0] === "TRUE";

/** `= true` after a condition, which leaves it as it is, NULL too. */
const EQUALS_TRUE = /^=\s*true(?![\w$])/i;

/** `IS TRUE` after a condition, which reads its NULL as FALSE. */
const IS_TRUE = /^is\s+true(?![\w$])/i;

/**
 * How the text around a condition reads it: as it is (parentheses around
 * it, `= true` after it), as `IS TRUE` (also with those), or otherwise
 * (undefined).
 */
const redundant = (
  before: string,
  after: string,
): "as is" | "is true" | undefined => {
  const opening = before.replace(/\s+/g, "");

  if (!/^\(*$/.test(opening)) {
    return undefined;
  }

  let depth = opening.length;
  let rest = after.trim();
  let reading: "as is" | "is true" = "as is";

  while (rest) {
    if (rest.startsWith(")")) {
      if (!depth) {
        return undefined;
      }

      depth -= 1;
      rest = rest.slice(1).trimStart();
      continue;
    }

    const equals = EQUALS_TRUE.exec(rest);
    const truth = equals ?? IS_TRUE.exec(rest);

    if (!truth) {
      return undefined;
    }

    if (!equals) {
      reading = "is true";
    }

    rest = rest.slice(truth[0].length).trimStart();
  }

  return depth ? undefined : reading;
};

/** `P IS TRUE` as the checks read it, one per template. */
const truthForms = new WeakMap<PredicateDescription, PredicateDescription>();

/**
 * The condition that `sql<boolean>\`${condition}\`` interpolates alone and
 * compares with TRUE, also in parentheses and with `= true` after it: the
 * checks read the template as that condition. With `IS TRUE` after it, they
 * read `NOT (condition IS NOT TRUE)`, which is FALSE, not NULL, where the
 * condition is NULL, so below a not() it holds there. Other SQL around it is
 * opaque.
 */
const written = (description: PredicateDescription): PredicateDescription => {
  if (
    description.kind !== "comparison" ||
    description.operator !== "=" ||
    description.left.kind !== "raw" ||
    !isTrueLiteral(description.right)
  ) {
    return description;
  }

  let condition: PredicateDescription | undefined;
  let before = "";
  let after = "";

  for (const part of description.left.parts) {
    if (typeof part === "string") {
      if (condition) {
        after += part;
      } else {
        before += part;
      }
    } else if (part.kind === "condition" && !condition) {
      condition = part.predicate;
    } else {
      return description;
    }
  }

  const reading = condition && redundant(before, after);

  if (!reading) {
    return description;
  }

  if (reading === "as is") {
    return written(condition!);
  }

  let form = truthForms.get(description);

  if (!form) {
    form = freeze({
      kind: "not",
      predicate: freeze({ kind: "notTrue", predicate: written(condition!) }),
    });
    truthForms.set(description, form);
  }

  return form;
};

const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;

const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && !Number.isNaN(value)
    ? value
    : typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && NUMBER_TEXT.test(value)
        ? Number(value)
        : undefined;

/** The operator with its sides swapped: `a < b` is `b > a`. */
const MIRRORED: Readonly<Record<string, string>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

/** A comparison of two known values; only numbers and booleans are compared. */
const comparedValues = (
  left: unknown,
  operator: string,
  right: unknown,
): Truth => {
  if (left === null || right === null) {
    return operator === "IS DISTINCT FROM"
      ? left !== right
      : operator === "IS NOT DISTINCT FROM"
        ? left === right
        : null;
  }

  if (typeof left === "boolean" || typeof right === "boolean") {
    if (typeof left !== typeof right) {
      return undefined;
    }

    return operator === "=" || operator === "IS NOT DISTINCT FROM"
      ? left === right
      : operator === "<>" || operator === "IS DISTINCT FROM"
        ? left !== right
        : undefined;
  }

  const first = numberOf(left);
  const second = numberOf(right);

  if (first === undefined || second === undefined) {
    return undefined;
  }

  switch (operator) {
    case "=":
    case "IS NOT DISTINCT FROM":
      return first === second;
    case "<>":
    case "IS DISTINCT FROM":
      return first !== second;
    case "<":
      return first < second;
    case "<=":
      return first <= second;
    case ">":
      return first > second;
    case ">=":
      return first >= second;
    default:
      return undefined;
  }
};

/** `left operator right`, where the left side is never NULL and may be a count. */
const comparedPresent = (
  left: Known,
  operator: string,
  right: unknown,
): Truth => {
  if (right === null) {
    return operator === "IS DISTINCT FROM"
      ? true
      : operator === "IS NOT DISTINCT FROM"
        ? false
        : null;
  }

  const bound = numberOf(right);

  if (!("count" in left) || bound === undefined) {
    return undefined;
  }

  // A count is a whole number of at least 0.
  const outside = bound < 0 || !Number.isInteger(bound);

  switch (operator) {
    case "=":
    case "IS NOT DISTINCT FROM":
      return outside ? false : undefined;
    case "<>":
    case "IS DISTINCT FROM":
      return outside ? true : undefined;
    case ">=":
      return bound <= 0 ? true : undefined;
    case ">":
      return bound < 0 ? true : undefined;
    case "<=":
      return bound < 0 ? false : undefined;
    case "<":
      return bound <= 0 ? false : undefined;
    default:
      return undefined;
  }
};

const compared = (
  left: Known | undefined,
  operator: string,
  right: Known | undefined,
): Truth => {
  if (!left || !right) {
    return undefined;
  }

  if ("value" in left && "value" in right) {
    return comparedValues(left.value, operator, right.value);
  }

  if ("value" in right) {
    return comparedPresent(left, operator, right.value);
  }

  return "value" in left
    ? comparedPresent(right, MIRRORED[operator] ?? operator, left.value)
    : undefined;
};

const sqlTypeOf = (node: ValueNode): string =>
  expressionSqlType({ node, outputName: "value" });

const isJson = (node: ValueNode): boolean => {
  const type = sqlTypeOf(node);

  return type === "jsonb" || type === "json";
};

/**
 * An empty array, or an empty JSON object or array: what `contains()` and
 * `overlaps()` compare with once request values emptied the list.
 */
const emptyOperand = (left: ValueNode, right: Known | undefined): boolean => {
  if (!right || !("value" in right)) {
    return false;
  }

  const { value } = right;

  if (sqlTypeOf(left).endsWith("[]")) {
    return Array.isArray(value) && !value.length;
  }

  return (
    isJson(left) &&
    (value === "{}" ||
      value === "[]" ||
      (Array.isArray(value) && !value.length) ||
      (!!value &&
        typeof value === "object" &&
        Object.getPrototypeOf(value) === Object.prototype &&
        !Object.keys(value).length))
  );
};

/** A LIKE pattern of only `%`, which every text matches: an emptied `like(prefix + "%")`. */
const matchesEveryText = (right: Known | undefined): boolean =>
  !!right &&
  "value" in right &&
  typeof right.value === "string" &&
  /^%+$/.test(right.value);

/**
 * A comparison with a nullable parameter bound to null, as the statement
 * runs it: `is(p)` is the null check and `isNot(p)` its negation.
 */
const boundToNull = (
  description: PredicateDescription,
  analysis: Analysis,
): PredicateDescription | undefined => {
  if (
    description.kind !== "comparison" ||
    !description.nullableParameter ||
    description.right.kind !== "placeholder" ||
    analysis.bound?.(description.right)?.value !== null
  ) {
    return undefined;
  }

  const check: PredicateDescription = description.nullCheck ?? {
    kind: "nullCheck",
    value: description.left,
    negated: false,
  };

  return description.operator === "<>"
    ? { kind: "not", predicate: check }
    : check;
};

/** `'null'::jsonb`, which is(null) of a NOT NULL jsonb column compares with. */
const isJsonNullLiteral = (node: ValueNode): boolean =>
  node.kind === "raw" &&
  node.parts.length === 1 &&
  node.parts[0] === "'null'::jsonb";

/**
 * The value that is(null) (`x IS NULL OR x = 'null'::jsonb`) or isNot(null)
 * (`x IS NOT NULL AND x <> 'null'::jsonb`) of a NOT NULL jsonb column tests:
 * one condition, never NULL, that counts JSON null as null.
 */
const jsonNullTested = (group: GroupDescription): ValueNode | undefined => {
  const [check, comparison] = group.predicates;
  const negative = group.operator === "AND";

  return group.predicates.length === 2 &&
    check?.kind === "nullCheck" &&
    check.negated === negative &&
    comparison?.kind === "comparison" &&
    comparison.operator === (negative ? "<>" : "=") &&
    isJsonNullLiteral(comparison.right) &&
    sameValue(check.value, comparison.left)
    ? check.value
    : undefined;
};

/**
 * The group of `operator` a term is (not is(null) of a NOT NULL jsonb
 * column), whose terms a group of that operator searches as its own;
 * undefined otherwise.
 */
const merged = (
  description: PredicateDescription,
  operator: GroupDescription["operator"],
): GroupDescription | undefined => {
  const current = written(description);

  return current.kind === "group" &&
    current.operator === operator &&
    !jsonNullTested(current)
    ? current
    : undefined;
};

/** Never NULL and not JSON, whose null reads as SQL NULL below a not(). */
const definite = (node: ValueNode, analysis: Analysis): boolean => {
  const entry = known(node, analysis);

  return (
    !!entry && !("value" in entry && entry.value === null) && !isJson(node)
  );
};

/** A condition that is TRUE or FALSE for every row, never NULL. */
const twoValued = (
  description: PredicateDescription,
  analysis: Analysis,
): boolean => {
  switch (description.kind) {
    case "nullCheck":
    case "exists":
    case "notTrue":
      return true;
    case "not":
      return twoValued(description.predicate, analysis);
    case "group":
      return (
        !!jsonNullTested(description) ||
        description.predicates.every((child) => twoValued(child, analysis))
      );
    case "comparison": {
      const condition = written(description);

      if (condition !== description) {
        return twoValued(condition, analysis);
      }

      // Bound to null, a nullable parameter's comparison is a null check.
      const nulled = boundToNull(description, analysis);

      if (nulled) {
        return twoValued(nulled, analysis);
      }

      return (
        description.operator === "IS NOT DISTINCT FROM" ||
        description.operator === "IS DISTINCT FROM" ||
        (definite(description.left, analysis) &&
          definite(description.right, analysis))
      );
    }
    case "membership":
      return (
        Array.isArray(description.values) &&
        definite(description.value, analysis) &&
        description.values.every((node: ValueNode) => definite(node, analysis))
      );
    case "between":
      return (
        definite(description.value, analysis) &&
        definite(description.lower, analysis) &&
        definite(description.upper, analysis)
      );
    default:
      return false;
  }
};

/** Numbers for bindings, columns and prepared scopes in the keys of conditions. */
const identities = new WeakMap<object, number>();
let identified = 0;

const identity = (object: object): number => {
  let id = identities.get(object);

  if (id === undefined) {
    identified += 1;
    id = identified;
    identities.set(object, id);
  }

  return id;
};

/**
 * A text only the same value has: a column of one binding, a JSON path into
 * one, or SQL around one (`NULLIF(…, 'null'::jsonb)`); undefined otherwise.
 */
const operandKey = (node: ValueNode): string | undefined => {
  const cached = operandKeys.get(node);

  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const key = newOperandKey(node);

  operandKeys.set(node, key ?? null);

  return key;
};

/** Operand keys by node, found once. */
const operandKeys = new WeakMap<ValueNode, string | null>();

const newOperandKey = (node: ValueNode): string | undefined => {
  switch (node.kind) {
    case "column":
      return `c${identity(node.description.binding)}.${identity(node.description.column)}`;
    case "jsonPath": {
      const inner = operandKey(node.value);

      return inner === undefined
        ? undefined
        : `p${inner}\u0001${JSON.stringify(node.path)}\u0001${node.scalarType ?? ""}`;
    }
    case "raw": {
      const [open, inner, close] = node.parts;

      if (
        node.parts.length !== 3 ||
        typeof open !== "string" ||
        typeof close !== "string" ||
        typeof inner !== "object"
      ) {
        return undefined;
      }

      // JSON null read as NULL, in any of its spellings.
      const json = jsonNullInner(node);
      const key = operandKey(json ?? inner);

      return key === undefined
        ? undefined
        : json
          ? `N${key}`
          : `r${open}\u0001${key}\u0001${close}`;
    }
    default:
      return undefined;
  }
};

/** What a literal binds and the type it is cast to. */
const literalKey = (
  value: unknown,
  cast: string | undefined,
): string | undefined => {
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return `v${cast ?? ""}\u0001${typeof value}${value}`;
    case "object":
      if (value === null) {
        return `v${cast ?? ""}\u0001null`;
      }

      try {
        return `v${cast ?? ""}\u0001o${JSON.stringify(
          value,
          (_key, item: unknown) =>
            typeof item === "bigint" ? `${item}n` : item,
        )}`;
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
};

type Bound = Extract<ValueNode, { kind: "parameter" | "placeholder" }>;

/**
 * The literal or parameter a value binds: itself, or the one that
 * `NULLIF(…, 'null'::jsonb)` reads with JSON null as NULL.
 */
const boundNode = (node: ValueNode): Bound | undefined => {
  const value = node.kind === "raw" ? jsonNullInner(node) : node;

  return value?.kind === "parameter" || value?.kind === "placeholder"
    ? value
    : undefined;
};

/** The type a literal or a parameter is cast to where it binds. */
const castOf = (node: ValueNode): string | undefined => {
  const value = boundNode(node);

  return value?.kind === "parameter"
    ? value.cast
    : value?.kind === "placeholder"
      ? value.codec?.parameterCast
      : undefined;
};

/** A value not known before the statement runs. */
const UNKNOWN = Symbol("unknown");

/**
 * The value of a literal, or of a parameter at this execution; JSON null
 * read through NULLIF() is null.
 */
const literalValue = (node: ValueNode, analysis: Analysis): unknown => {
  if (node.kind === "parameter") {
    return node.value;
  }

  const value = boundNode(node);

  if (!value) {
    return UNKNOWN;
  }

  if (value !== node) {
    const inner = literalValue(value, analysis);

    return isJsonNullText(inner) ? null : inner;
  }

  const bound = analysis.bound?.(value as PlaceholderNode);

  return bound ? bound.value : UNKNOWN;
};

/**
 * A text only the same value has: a literal or a parameter by the value it
 * binds (a parameter of unknown value by itself), or an operand.
 */
const valueKey = (node: ValueNode, analysis: Analysis): string | undefined => {
  const bound = boundNode(node);

  if (bound) {
    const value = literalValue(node, analysis);

    if (value !== UNKNOWN) {
      return literalKey(value, castOf(bound));
    }

    const { scope, name } = bound as PlaceholderNode;

    // Unknown, NULLIF() of a parameter is the parameter but for JSON null.
    return `$${identity(scope)}\u0001${name}${bound === node ? "" : "\u0001n"}`;
  }

  const key = operandKey(node);

  return key === undefined ? undefined : `@${key}`;
};

/** Types whose values a JS number orders exactly as PostgreSQL does. */
const ORDERED_NUMBER =
  /^(?:smallint|integer|bigint|int[248]?|double precision|float8|numeric|decimal)(?:\(\d+(?:,\s*\d+)?\))?$/;

/** ORDERED_NUMBER of types, found once. */
const orderedTypes = new Map<string, boolean>();

/** Whether a type's values a JS number orders exactly as PostgreSQL does (ORDERED_NUMBER). */
const orderedNumber = (type: string): boolean => {
  let ordered = orderedTypes.get(type);

  if (ordered === undefined) {
    ordered = ORDERED_NUMBER.test(type);
    orderedTypes.set(type, ordered);
  }

  return ordered;
};

/** A value a JS number holds exactly: a number, a safe bigint or a number's own text. */
const exactNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
  }

  if (typeof value !== "string" || !NUMBER_TEXT.test(value)) {
    return undefined;
  }

  const number = Number(value);

  return String(number) === value ? number : undefined;
};

/** Numbers from `from` to `to`, each end included or not; an infinite end is open. */
type Interval = {
  readonly from: number;
  readonly fromIn: boolean;
  readonly to: number;
  readonly toIn: boolean;
};

/**
 * The numbers a term admits of one number operand (`x < 5`, `x = 5`,
 * `between(1, 3)`), as intervals in order that neither overlap nor touch.
 */
type Range = {
  readonly key: string;
  readonly operand: ValueNode;
  readonly intervals: readonly Interval[];
};

const EVERY_NUMBER: readonly Interval[] = Object.freeze([
  Object.freeze({ from: -Infinity, fromIn: false, to: Infinity, toIn: false }),
]);

/** Whether an interval holds no number. */
const hollow = ({ from, fromIn, to, toIn }: Interval): boolean =>
  from > to || (from === to && !(fromIn && toIn));

/** Intervals in order, those that overlap or touch joined: the numbers any of them admits. */
const union = (intervals: readonly Interval[]): Interval[] => {
  const sorted = intervals
    .filter((interval) => !hollow(interval))
    .sort((a, b) => a.from - b.from || Number(b.fromIn) - Number(a.fromIn));
  const joined: Interval[] = [];

  for (const interval of sorted) {
    const last = joined[joined.length - 1];

    if (
      last &&
      (interval.from < last.to ||
        (interval.from === last.to && (interval.fromIn || last.toIn)))
    ) {
      if (interval.to > last.to || (interval.to === last.to && interval.toIn)) {
        joined[joined.length - 1] = {
          ...last,
          to: interval.to,
          toIn: interval.toIn,
        };
      }
    } else {
      joined.push(interval);
    }
  }

  return joined;
};

/**
 * The position, in a list of intervals in order and apart, of the first one
 * that union() would not keep before `interval` and apart from it: the first
 * that ends after `interval` starts, or where it starts with either end
 * included.
 */
const firstNotBefore = (
  intervals: readonly Interval[],
  interval: Interval,
): number => {
  let low = 0;
  let high = intervals.length;

  while (low < high) {
    const middle = (low + high) >> 1;
    const { to, toIn } = intervals[middle]!;

    if (
      to < interval.from ||
      (to === interval.from && !toIn && !interval.fromIn)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

/** Whether a list of intervals in order, apart, shares a number with an interval. */
const meets = (intervals: readonly Interval[], interval: Interval): boolean => {
  let low = 0;
  let high = intervals.length;

  // The first interval that does not end below the interval's start.
  while (low < high) {
    const middle = (low + high) >> 1;
    const { to, toIn } = intervals[middle]!;

    if (
      to < interval.from ||
      (to === interval.from && !(toIn && interval.fromIn))
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const found = intervals[low];

  return (
    !!found &&
    (found.from < interval.to ||
      (found.from === interval.to && found.fromIn && interval.toIn))
  );
};

/**
 * A list of at most this many intervals, beside a longer one, is checked
 * against it gap by gap (see intersection()) instead of walked in full.
 */
const LOOKED_UP = 4;

/**
 * union() of two lists of intervals in order, apart, in one pass: a group's
 * range is read again in each group around it.
 */
const unionOf = (
  first: readonly Interval[],
  second: readonly Interval[],
): readonly Interval[] => {
  if (!second.length) {
    return first;
  }

  if (!first.length) {
    return second;
  }

  // One interval apart from those of a long list goes in between them.
  const [one, other] =
    second.length === 1 ? [second[0]!, first] : [first[0]!, second];

  if ((second.length === 1 || first.length === 1) && !hollow(one)) {
    const position = firstNotBefore(other, one);
    const next = other[position];

    if (
      !next ||
      one.to < next.from ||
      (one.to === next.from && !one.toIn && !next.fromIn)
    ) {
      const joined = other.slice(0, position);

      joined.push(one);

      for (let index = position; index < other.length; index += 1) {
        joined.push(other[index]!);
      }

      return joined;
    }
  }

  const joined: Interval[] = [];
  let i = 0;
  let j = 0;

  while (i < first.length || j < second.length) {
    const a = first[i];
    const b = second[j];
    // In union()'s order: by the start, an included start first.
    const interval =
      !b ||
      (a && (a.from < b.from || (a.from === b.from && (a.fromIn || !b.fromIn))))
        ? a!
        : b;

    if (interval === a) {
      i += 1;
    } else {
      j += 1;
    }

    if (hollow(interval)) {
      continue;
    }

    const last = joined[joined.length - 1];

    if (
      last &&
      (interval.from < last.to ||
        (interval.from === last.to && (interval.fromIn || last.toIn)))
    ) {
      if (interval.to > last.to || (interval.to === last.to && interval.toIn)) {
        joined[joined.length - 1] = {
          ...last,
          to: interval.to,
          toIn: interval.toIn,
        };
      }
    } else {
      joined.push(interval);
    }
  }

  return joined;
};

/** The numbers both lists of intervals (in order, apart) admit. */
const intersection = (
  first: readonly Interval[],
  second: readonly Interval[],
): readonly Interval[] => {
  // Every number leaves the other list as it is.
  if (everyNumber(first)) {
    return second;
  }

  if (everyNumber(second)) {
    return first;
  }

  // A long list that meets none of the few gaps a short one leaves lies
  // inside the short one and stays as it is (`x <> 5` beside x's many
  // pieces).
  for (const [long, short] of [
    [first, second],
    [second, first],
  ] as const) {
    if (short.length <= LOOKED_UP && long.length > LOOKED_UP) {
      const gaps = firstGaps(short, LOOKED_UP + 1);

      if (!gaps.some((gap) => meets(long, gap))) {
        return long;
      }
    }
  }

  const shared: Interval[] = [];
  let i = 0;
  let j = 0;

  while (i < first.length && j < second.length) {
    const a = first[i]!;
    const b = second[j]!;
    const from = Math.max(a.from, b.from);
    const fromIn =
      a.from === b.from
        ? a.fromIn && b.fromIn
        : a.from > b.from
          ? a.fromIn
          : b.fromIn;
    const to = Math.min(a.to, b.to);
    const toIn =
      a.to === b.to ? a.toIn && b.toIn : a.to < b.to ? a.toIn : b.toIn;

    if (!(from > to || (from === to && !(fromIn && toIn)))) {
      // An interval the other one holds whole is kept as it is.
      shared.push(
        a.from === from && a.fromIn === fromIn && a.to === to && a.toIn === toIn
          ? a
          : b.from === from &&
              b.fromIn === fromIn &&
              b.to === to &&
              b.toIn === toIn
            ? b
            : { from, fromIn, to, toIn },
      );
    }

    if (a.to < b.to || (a.to === b.to && !a.toIn)) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return shared;
};

/** The numbers intervals (in order, apart) leave out. */
const complement = (intervals: readonly Interval[]): Interval[] => {
  const gaps: Interval[] = [];
  let from = -Infinity;
  let fromIn = false;

  for (const interval of intervals) {
    const gap = { from, fromIn, to: interval.from, toIn: !interval.fromIn };

    if (!hollow(gap)) {
      gaps.push(gap);
    }

    from = interval.to;
    fromIn = !interval.toIn;
  }

  if (from !== Infinity) {
    gaps.push({ from, fromIn, to: Infinity, toIn: false });
  }

  return gaps;
};

/** Whether intervals in order, apart, admit every number. */
const everyNumber = (intervals: readonly Interval[]): boolean =>
  intervals.length === 1 &&
  intervals[0]!.from === -Infinity &&
  intervals[0]!.to === Infinity;

type Comparison = Extract<PredicateDescription, { kind: "comparison" }>;

/**
 * A condition as `sign ? core : NOT core`, in the form opposite conditions
 * share; `coreOf()` makes the core, which only a found pair needs.
 */
type Term = {
  readonly sign: boolean;
  /** The same key is the same condition; without one, only sameExpression() tells. */
  readonly key: string | undefined;
  readonly range: Range | undefined;
  /** The condition, negated as written or a comparison before its rewrite. */
  readonly base: PredicateDescription;
  /** A comparison's operator and right side in the shared form. */
  readonly operator: Comparison["operator"] | undefined;
  readonly right: ValueNode | undefined;
  /**
   * What an `IS [NOT] DISTINCT FROM` of a value answers, with the term's
   * sign, where its operand is NULL (or JSON null read as NULL): TRUE for
   * IS DISTINCT FROM, FALSE for IS NOT DISTINCT FROM, the other way below a
   * not(). It is never NULL, and elsewhere it is the opposite of its pair.
   */
  readonly onNull?: boolean | undefined;
};

const coreOf = (term: Term): PredicateDescription => {
  const { base } = term;

  switch (base.kind) {
    case "comparison":
      return term.operator === base.operator && term.right === base.right
        ? base
        : { ...base, operator: term.operator!, right: term.right! };
    case "nullCheck":
    case "membership":
    case "exists":
      return base.negated ? { ...base, negated: false } : base;
    default:
      return base;
  }
};

/** A term without a key, operator or range: only the same description matches it. */
const plainTerm = (
  base: PredicateDescription,
  sign: boolean,
  key?: string,
  range?: Range,
): Term => ({
  sign,
  key,
  range,
  base,
  operator: undefined,
  right: undefined,
});

/**
 * The numbers `x < n` (`"<"`), `x > n` (`">"`) or `x = n` (`"="`) admits,
 * or with `sign` false its opposite admits.
 */
const admitted = (
  operator: "<" | ">" | "=",
  value: number,
  sign: boolean,
): readonly Interval[] => {
  const below = operator === "<" ? sign : operator === ">" && !sign;

  if (operator !== "=") {
    // Below `value` (`<`, NOT `>`), or above it (`>`, NOT `<`); NOT includes it.
    return below
      ? [{ from: -Infinity, fromIn: false, to: value, toIn: !sign }]
      : [{ from: value, fromIn: !sign, to: Infinity, toIn: false }];
  }

  return sign
    ? [{ from: value, fromIn: true, to: value, toIn: true }]
    : [
        { from: -Infinity, fromIn: false, to: value, toIn: false },
        { from: value, fromIn: false, to: Infinity, toIn: false },
      ];
};

/** At most this many conditions of one group are read as one range. */
const RANGE_TERMS = 16;

/** Whether a group compares with a parameter anywhere, found once. */
const valuedGroups = new WeakMap<GroupDescription, boolean>();

const placeholderBound = (node: ValueNode): boolean =>
  boundNode(node)?.kind === "placeholder";

/** Whether a condition compares with a parameter, whose value an execution binds. */
const valued = (description: PredicateDescription): boolean => {
  const current = written(description);

  switch (current.kind) {
    case "not":
    case "notTrue":
      return valued(current.predicate);
    case "group": {
      let found = valuedGroups.get(current);

      if (found === undefined) {
        found = current.predicates.some(valued);
        valuedGroups.set(current, found);
      }

      return found;
    }
    case "comparison":
      return placeholderBound(current.left) || placeholderBound(current.right);
    case "membership":
      return (
        Array.isArray(current.values) &&
        (current.values as readonly ValueNode[]).some(placeholderBound)
      );
    case "between":
      return (
        placeholderBound(current.value) ||
        placeholderBound(current.lower) ||
        placeholderBound(current.upper)
      );
    default:
      return false;
  }
};

/** A group of conditions that are neither groups nor negations. */
const flat = (group: GroupDescription): boolean =>
  group.predicates.every((child) => {
    const { kind } = written(child);

    return kind !== "group" && kind !== "not" && kind !== "notTrue";
  });

/**
 * The ranges of groups with groups or negations in them, by sign, found once:
 * of any such group without an analysis of bound values, and of one without
 * parameters in every analysis.
 */
const groupRanges = new WeakMap<GroupDescription, (Range | null)[]>();

/**
 * The numbers a group of conditions of one number operand admits together
 * (`and(x.atLeast(5), x.atLeast(4))`), negated by De Morgan below a not().
 */
const groupRange = (
  group: GroupDescription,
  analysis: Analysis,
  sign: boolean,
): Range | undefined => {
  if (group.predicates.length > RANGE_TERMS) {
    return undefined;
  }

  // A range is read again for each group around it: each is kept.
  const kept = !flat(group) && (!analysis.bound || !valued(group));
  const position = sign ? 1 : 0;

  if (kept) {
    const cached = groupRanges.get(group)?.[position];

    if (cached !== undefined) {
      return cached ?? undefined;
    }
  }

  const range = joinedRange(group, analysis, sign);

  if (kept) {
    let entry = groupRanges.get(group);

    if (!entry) {
      entry = [];
      groupRanges.set(group, entry);
    }

    entry[position] = range ?? null;
  }

  return range;
};

/** groupRange() of a group of at most RANGE_TERMS conditions, not kept. */
const joinedRange = (
  group: GroupDescription,
  analysis: Analysis,
  sign: boolean,
): Range | undefined => {
  // NOT (a AND b) is NOT a OR NOT b, NOT (a OR b) NOT a AND NOT b.
  const every = (group.operator === "AND") === sign;
  let range: Range | undefined;
  let intervals: readonly Interval[] = every ? EVERY_NUMBER : [];

  for (const child of group.predicates) {
    const part = rangeOf(child, analysis, sign);

    if (!part || (range && part.key !== range.key)) {
      return undefined;
    }

    range = range ?? part;
    intervals = every
      ? intersection(intervals, part.intervals)
      : unionOf(intervals, part.intervals);
  }

  return range && { ...range, intervals };
};

/** The numbers a condition admits of one number operand, as its term reads them. */
const rangeOf = (
  description: PredicateDescription,
  analysis: Analysis,
  sign: boolean,
): Range | undefined => {
  const current = written(description);

  switch (current.kind) {
    case "not":
      return rangeOf(current.predicate, analysis, !sign);
    // A range counts only for an operand never NULL, where P IS NOT TRUE is NOT P.
    case "notTrue":
      return rangeOf(current.predicate, analysis, !sign);
    case "group":
      return jsonNullTested(current)
        ? undefined
        : groupRange(current, analysis, sign);
    case "between":
      return betweenRange(current, analysis, sign);
    case "comparison":
      return termOf(current, analysis, sign).range;
    case "membership":
      return Array.isArray(current.values) && current.values.length === 1
        ? termOf(current, analysis, sign).range
        : undefined;
    default:
      return undefined;
  }
};

/**
 * `a <> b` is NOT `a = b`, `a >= b` NOT `a < b`, `a <= b` NOT `a > b`, and
 * `IS DISTINCT FROM` NOT `IS NOT DISTINCT FROM`.
 */
const OPPOSITES: Readonly<Record<string, Comparison["operator"]>> = {
  "<>": "=",
  ">=": "<",
  "<=": ">",
  "IS DISTINCT FROM": "IS NOT DISTINCT FROM",
};

/** `true`, bound as the literal it replaces is. */
const trueLiteral = (cast: string | undefined): ValueNode =>
  freeze(
    cast
      ? { kind: "parameter", value: true, cast }
      : { kind: "parameter", value: true },
  );

const comparisonTerm = (
  description: Comparison,
  analysis: Analysis,
  positive: boolean,
): Term => {
  let sign = positive;
  let operator = description.operator;
  let right = description.right;
  const opposite = OPPOSITES[operator];

  if (opposite) {
    operator = opposite;
    sign = !sign;
  }

  const value = literalValue(right, analysis);
  const cast = castOf(right);
  // Against a value, IS NOT DISTINCT FROM is = where the other side is not
  // NULL: `isDistinctFrom(2)` is the opposite of `is(2)` there. It reads
  // JSON null as NULL alike: NULLIF(x, 'null') IS DISTINCT FROM 2 is
  // x IS DISTINCT FROM 2.
  const distinct =
    operator === "IS NOT DISTINCT FROM" && value !== UNKNOWN && value !== null;

  if (distinct) {
    operator = "=";
  }

  // `flag = false` is NOT `flag = true`, NULL alike for a NULL flag.
  const flipped = operator === "=" && value === false;

  if (flipped) {
    right = trueLiteral(cast);
    sign = !sign;
  }

  const left = operandKey(
    distinct
      ? (jsonNullInner(description.left) ?? description.left)
      : description.left,
  );
  const compared =
    left === undefined
      ? undefined
      : value === UNKNOWN
        ? valueKey(right, analysis)
        : literalKey(flipped ? true : value, cast);
  const number =
    analysis !== RANGELESS &&
    left !== undefined &&
    (operator === "<" || operator === ">" || operator === "=") &&
    orderedNumber(sqlTypeOf(description.left))
      ? exactNumber(value)
      : undefined;

  return {
    sign,
    key:
      compared === undefined
        ? undefined
        : `${operator}\u0001${left}\u0001${compared}`,
    // `x < 5` admits values below 5 and NOT `x < 5` those from 5 on.
    range:
      number !== undefined
        ? {
            key: left!,
            operand: description.left,
            intervals: admitted(operator as "<" | ">" | "=", number, sign),
          }
        : undefined,
    base: description,
    operator,
    right,
    // IS DISTINCT FROM a value holds where the operand is NULL, IS NOT
    // DISTINCT FROM does not; a negative sign turns it around.
    onNull: distinct
      ? (description.operator === "IS DISTINCT FROM") === positive
      : undefined,
  };
};

/** The numbers `between(a, b)` of a number operand admits, or with `sign` false NOT it. */
const betweenRange = (
  description: Extract<PredicateDescription, { kind: "between" }>,
  analysis: Analysis,
  sign: boolean,
): Range | undefined => {
  const key = operandKey(description.value);
  const from = exactNumber(literalValue(description.lower, analysis));
  const to = exactNumber(literalValue(description.upper, analysis));

  if (
    key === undefined ||
    from === undefined ||
    to === undefined ||
    !orderedNumber(sqlTypeOf(description.value))
  ) {
    return undefined;
  }

  const interval = { from, fromIn: true, to, toIn: true };
  const intervals = hollow(interval) ? [] : [interval];

  return {
    key,
    operand: description.value,
    intervals: sign ? intervals : complement(intervals),
  };
};

/** The keys of a list without a parameter, found once. */
const listKeyCache = new WeakMap<object, readonly string[] | null>();

/**
 * The keys of a list's values, in order, each once; undefined when a value
 * has none. One value written twice is one value.
 */
const listKeys = (
  description: Extract<PredicateDescription, { kind: "membership" }>,
  analysis: Analysis,
): readonly string[] | undefined => {
  const cached = listKeyCache.get(description);

  // Only a list without a parameter is kept.
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const values = description.values as readonly ValueNode[];
  const fixed = !values.some((node) => boundNode(node)?.kind === "placeholder");
  const keys = new Set<string>();
  let complete = true;

  for (const node of values) {
    const key = valueKey(node, analysis);

    if (key === undefined) {
      complete = false;
      break;
    }

    keys.add(key);
  }

  const found = complete ? [...keys].sort() : undefined;

  if (fixed) {
    listKeyCache.set(description, found ?? null);
  }

  return found;
};

const termOf = (
  description: PredicateDescription,
  analysis: Analysis,
  sign = true,
): Term => {
  const current = written(description);

  switch (current.kind) {
    case "not":
      return termOf(current.predicate, analysis, !sign);
    // A pair or a range counts only where the condition is never NULL, and
    // there P IS NOT TRUE is NOT P.
    case "notTrue":
      return termOf(current.predicate, analysis, !sign);
    case "group": {
      const value = jsonNullTested(current);
      const key = value && operandKey(value);

      // is(null) and its opposite isNot(null) of a NOT NULL jsonb column.
      return key === undefined
        ? plainTerm(
            current,
            sign,
            undefined,
            analysis === RANGELESS
              ? undefined
              : groupRange(current, analysis, sign),
          )
        : plainTerm(
            { kind: "nullCheck", value: value!, negated: false },
            current.operator === "OR" ? sign : !sign,
            `j${key}`,
          );
    }
    case "nullCheck": {
      // `NULLIF(x, 'null'::jsonb) IS NULL` is is(null) of x, as the
      // `x IS NULL OR x = 'null'::jsonb` of a NOT NULL jsonb column is.
      const json = jsonNullInner(current.value);
      const key = operandKey(json ?? current.value);

      return plainTerm(
        current,
        current.negated ? !sign : sign,
        key === undefined ? undefined : `${json ? "j" : "n"}${key}`,
      );
    }
    case "membership": {
      const positive = current.negated ? !sign : sign;

      if (!Array.isArray(current.values)) {
        return plainTerm(current, positive);
      }

      const values = current.values as readonly ValueNode[];
      const left = values.length > 1 ? operandKey(current.value) : undefined;
      const keys = left === undefined ? undefined : listKeys(current, analysis);

      // in([x]) is is(x), notIn([x]) isNot(x); so is a list of one value
      // written more than once.
      if (values.length === 1 || keys?.length === 1) {
        return comparisonTerm(
          {
            kind: "comparison",
            left: current.value,
            operator: "=",
            right: values[0]!,
          },
          analysis,
          positive,
        );
      }

      // The same values in any order are the same list.
      return plainTerm(
        current,
        positive,
        keys && `m${left}\u0001${keys.join("\u0001")}`,
      );
    }
    case "between": {
      const value = operandKey(current.value);
      const lower =
        value === undefined ? undefined : valueKey(current.lower, analysis);
      const upper =
        lower === undefined ? undefined : valueKey(current.upper, analysis);

      return plainTerm(
        current,
        sign,
        upper === undefined
          ? undefined
          : `b${value}\u0001${lower}\u0001${upper}`,
        analysis === RANGELESS
          ? undefined
          : betweenRange(current, analysis, sign),
      );
    }
    case "exists":
      return plainTerm(current, current.negated ? !sign : sign);
    case "comparison": {
      const nulled = boundToNull(current, analysis);

      if (nulled) {
        return termOf(nulled, analysis, sign);
      }

      // IS DISTINCT FROM NULL is isNot(null), IS NOT DISTINCT FROM NULL is(null).
      if (
        (current.operator === "IS DISTINCT FROM" ||
          current.operator === "IS NOT DISTINCT FROM") &&
        literalValue(current.right, analysis) === null
      ) {
        return termOf(
          {
            kind: "nullCheck",
            value: current.left,
            negated: current.operator === "IS DISTINCT FROM",
          },
          analysis,
          sign,
        );
      }

      return comparisonTerm(current, analysis, sign);
    }
    default:
      return plainTerm(current, sign);
  }
};

/** rangedByValues() of groups, found once. */
const rangedGroups = new WeakMap<GroupDescription, boolean>();

/**
 * A group of conditions of one operand read as one range (see groupRange())
 * whose numbers the values a prepared write binds decide.
 */
const rangedByValues = (description: PredicateDescription): boolean => {
  const current = written(description);

  if (current.kind === "not" || current.kind === "notTrue") {
    return rangedByValues(current.predicate);
  }

  if (current.kind !== "group") {
    return false;
  }

  let ranged = rangedGroups.get(current);

  if (ranged === undefined) {
    ranged =
      current.predicates.length <= RANGE_TERMS &&
      !jsonNullTested(current) &&
      current.predicates.some(
        (child) => dependsOnValues(child) || rangedByValues(child),
      );
    rangedGroups.set(current, ranged);
  }

  return ranged;
};

/** A term whose form depends on the values a prepared write binds. */
const dependsOnValues = (description: PredicateDescription): boolean => {
  const current = written(description);

  switch (current.kind) {
    case "not":
    case "notTrue":
      return dependsOnValues(current.predicate);
    case "comparison":
      return boundNode(current.right)?.kind === "placeholder";
    case "membership":
      return (
        Array.isArray(current.values) &&
        (current.values as readonly ValueNode[]).some(
          (node) => node.kind === "placeholder",
        )
      );
    case "between":
      return (
        current.lower.kind === "placeholder" ||
        current.upper.kind === "placeholder"
      );
    default:
      return false;
  }
};

/**
 * Fields that sameExpression() compares by identity, or that hold no
 * parameter it compares: a parameter inside them changes no comparison.
 */
const OPAQUE_FIELDS = new Set([
  "binding",
  "bindings",
  "root",
  "from",
  "scope",
  "codec",
  "column",
  "failure",
  "locking",
]);

/** placeholderIn() of conditions, nodes and subqueries, found once (null for none). */
const placeholdersIn = new WeakMap<object, PlaceholderNode | null>();

/**
 * A prepared parameter that a condition, value or subquery holds where
 * sameExpression() compares it: in its subqueries too, not in their tables.
 */
const placeholderIn = (value: unknown): PlaceholderNode | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  let found = placeholdersIn.get(value);

  if (found === undefined) {
    found = null;

    if ((value as { kind?: unknown }).kind === "placeholder") {
      found = value as PlaceholderNode;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        found = placeholderIn(item) ?? null;

        if (found) {
          break;
        }
      }
    } else {
      for (const field in value) {
        found = OPAQUE_FIELDS.has(field)
          ? null
          : (placeholderIn((value as Record<string, unknown>)[field]) ?? null);

        if (found) {
          break;
        }
      }
    }

    placeholdersIn.set(value, found);
  }

  return found ?? undefined;
};

/**
 * `isNot(null)` as written (see nullPredicate()), from the is(null) that a
 * comparison with a nullable parameter keeps: a negated null check, and
 * for a NOT NULL jsonb column `x IS NOT NULL AND x <> 'null'::jsonb`.
 */
const negatedCheck = (check: PredicateDescription): PredicateDescription => {
  if (check.kind === "nullCheck") {
    return { ...check, negated: !check.negated };
  }

  const [test, comparison] =
    check.kind === "group" ? check.predicates : ([] as const);

  return check.kind === "group" &&
    check.predicates.length === 2 &&
    test?.kind === "nullCheck" &&
    comparison?.kind === "comparison"
    ? {
        kind: "group",
        operator: dual(check.operator),
        predicates: [
          { ...test, negated: !test.negated },
          {
            ...comparison,
            operator: comparison.operator === "=" ? "<>" : "=",
          },
        ],
      }
    : { kind: "not", predicate: check };
};

/** Compares as two parameters compare in sameExpression(). */
const sameParameter = (first: unknown, second: unknown): boolean => {
  if (!isDeepStrictEqual(first, second)) {
    return false;
  }

  if (first === null || typeof first !== "object") {
    return true;
  }

  const representation = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? String(value) : value;

  try {
    return (
      JSON.stringify(first, representation) ===
      JSON.stringify(second, representation)
    );
  } catch {
    return false;
  }
};

/** sameUnder() at any values: whether some values can make two conditions the same. */
const ANY_VALUES: Analysis = Object.freeze({ roots: [] });

/** A comparison with a parameter that may be null, which binds as is(null) or isNot(null) there. */
const nullableComparison = (value: object): value is Comparison =>
  (value as { kind?: unknown }).kind === "comparison" &&
  !!(value as Comparison).nullableParameter &&
  (value as Comparison).right.kind === "placeholder";

/** Conditions a comparison bound to null can be the same as. */
const NULL_FORMS = new Set(["comparison", "nullCheck", "group", "not"]);

/**
 * sameExpression() of two conditions or values as the same filter written
 * with this analysis's values compares them: a parameter as the literal its
 * value writes (valueNode()), or as itself where it is not known; a
 * comparison with a nullable parameter bound to null as is(null) or
 * isNot(null); a LIMIT or OFFSET as its number. With ANY_VALUES, whether
 * some values make them the same: a parameter matches any literal or
 * parameter, and a comparison with a nullable one any comparison, null
 * check, group or not().
 */
const sameUnder = (
  left: unknown,
  right: unknown,
  analysis: Analysis,
): boolean => {
  const wild = analysis === ANY_VALUES;
  const literal = (node: PlaceholderNode): ValueNode => {
    const bound = analysis.bound?.(node);

    if (!bound) {
      return node;
    }

    const cast = node.codec?.parameterCast;
    const sqlType = node.codec?.sqlType;

    return cast
      ? sqlType
        ? { kind: "parameter", value: bound.value, cast, sqlType }
        : { kind: "parameter", value: bound.value, cast }
      : sqlType
        ? { kind: "parameter", value: bound.value, sqlType }
        : { kind: "parameter", value: bound.value };
  };
  const placeholder = (value: unknown): value is PlaceholderNode =>
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "placeholder";
  const amount = (value: unknown): unknown => {
    if (!placeholder(value)) {
      return value;
    }

    const bound = analysis.bound?.(value)?.value;

    return typeof bound === "number" ? bound : value;
  };
  const equivalent = (
    first: unknown,
    second: unknown,
    field?: string,
    correspondence?: ReadonlyMap<TableBinding, TableBinding>,
  ): boolean => {
    if (first === second) {
      return true;
    }

    if (field === "binding" || field === "root" || field === "from") {
      return correspondence?.get(first as TableBinding) === second;
    }

    if (field === "limit" || field === "offset") {
      if (wild && (placeholder(first) || placeholder(second))) {
        return (
          (placeholder(first) || typeof first === "number") &&
          (placeholder(second) || typeof second === "number")
        );
      }

      const from = amount(first);
      const to = amount(second);

      if (from !== first || to !== second) {
        return from === to || equivalent(from, to, undefined, correspondence);
      }
    }

    if (field === "scope" || field === "codec") {
      return false;
    }

    if (
      !first ||
      !second ||
      typeof first !== "object" ||
      typeof second !== "object"
    ) {
      return false;
    }

    if (wild) {
      const bound = (value: object) =>
        placeholder(value) ||
        (value as { kind?: unknown }).kind === "parameter";

      if (
        (placeholder(first) || placeholder(second)) &&
        bound(first) &&
        bound(second)
      ) {
        return true;
      }

      if (nullableComparison(first) || nullableComparison(second)) {
        return (
          NULL_FORMS.has((first as { kind?: string }).kind ?? "") &&
          NULL_FORMS.has((second as { kind?: string }).kind ?? "")
        );
      }
    } else {
      const resolve = (value: object): unknown =>
        placeholder(value)
          ? literal(value)
          : nullableComparison(value) &&
              analysis.bound?.(value.right as PlaceholderNode)?.value === null
            ? value.operator === "<>"
              ? negatedCheck(value.nullCheck ?? nullCheckOf(value.left))
              : (value.nullCheck ?? nullCheckOf(value.left))
            : value;
      const from = resolve(first);
      const to = resolve(second);

      if (from !== first || to !== second) {
        return equivalent(from, to, field, correspondence);
      }
    }

    // As sameExpression() compares the rest.
    if ("kind" in first && first.kind === "parameter") {
      const parameter = first as Extract<ValueNode, { kind: "parameter" }>;
      const other = second as Partial<typeof parameter>;

      return (
        other.kind === "parameter" &&
        parameter.cast === other.cast &&
        parameter.sqlType === other.sqlType &&
        sameParameter(parameter.value, other.value)
      );
    }

    if (
      "kind" in first &&
      first.kind === "select" &&
      "kind" in second &&
      second.kind === "select"
    ) {
      const firstQuery = first as SelectPlan;
      const secondQuery = second as SelectPlan;
      const aliases = Object.keys(firstQuery.bindings);
      const localBindings = new Map(correspondence);

      if (aliases.length !== Object.keys(secondQuery.bindings).length) {
        return false;
      }

      for (const alias of aliases) {
        const firstBinding = firstQuery.bindings[alias]!;
        const secondBinding = secondQuery.bindings[alias];

        if (
          !secondBinding ||
          firstBinding.table !== secondBinding.table ||
          firstBinding.alias !== secondBinding.alias ||
          firstBinding.derived !== secondBinding.derived ||
          firstBinding.cte !== secondBinding.cte ||
          firstBinding.cteReference !== secondBinding.cteReference
        ) {
          return false;
        }

        localBindings.set(firstBinding, secondBinding);
      }

      return (
        Object.keys(firstQuery).length === Object.keys(secondQuery).length &&
        Object.keys(firstQuery).every(
          (name) =>
            Object.hasOwn(secondQuery, name) &&
            (name === "bindings" ||
              equivalent(
                firstQuery[name as keyof SelectPlan],
                secondQuery[name as keyof SelectPlan],
                name,
                localBindings,
              )),
        )
      );
    }

    const fields = Object.keys(first);

    return (
      fields.length === Object.keys(second).length &&
      fields.every(
        (name) =>
          Object.hasOwn(second, name) &&
          equivalent(
            (first as Record<string, unknown>)[name],
            (second as Record<string, unknown>)[name],
            name,
            correspondence,
          ),
      )
    );
  };

  return equivalent(left, right);
};

/** The null check boundToNull() reads a comparison without one as. */
const nullCheckOf = (value: ValueNode): PredicateDescription => ({
  kind: "nullCheck",
  value,
  negated: false,
});

/**
 * The literals and parameters a condition holds, as sameUnder() reads them
 * with this analysis's values, sorted: two conditions that it finds the
 * same hold the same ones, so two that differ here need no comparison.
 */
const boundPrint = (
  description: PredicateDescription,
  analysis: Analysis,
): string => {
  const keys: string[] = [];
  const key = (value: unknown, cast?: string, sqlType?: string) =>
    `${cast ?? ""}\u0001${sqlType ?? ""}\u0001${literalKey(value, undefined) ?? "?"}`;
  const visit = (value: unknown, field?: string): void => {
    if (
      !value ||
      typeof value !== "object" ||
      (field !== undefined &&
        (OPAQUE_FIELDS.has(field) || field === "limit" || field === "offset"))
    ) {
      return;
    }

    const node = value as { kind?: unknown };

    if (node.kind === "placeholder") {
      const placeholder = value as PlaceholderNode;
      const bound = analysis.bound?.(placeholder);

      keys.push(
        bound
          ? key(
              bound.value,
              placeholder.codec?.parameterCast,
              placeholder.codec?.sqlType,
            )
          : `$${identity(placeholder.scope)}\u0001${placeholder.name}`,
      );
    } else if (node.kind === "parameter") {
      const parameter = value as Extract<ValueNode, { kind: "parameter" }>;

      keys.push(key(parameter.value, parameter.cast, parameter.sqlType));
    } else if (
      nullableComparison(value) &&
      analysis.bound?.(value.right as PlaceholderNode)?.value === null
    ) {
      visit(value.nullCheck ?? nullCheckOf(value.left));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
    } else {
      for (const name in value) {
        visit((value as Record<string, unknown>)[name], name);
      }
    }
  };

  visit(description);

  return keys.sort().join("\u0002");
};

/**
 * Above this many terms, counted with those of the groups it spreads into
 * (see termsOf()), a group is not searched for opposites or ranges: a bound
 * on the work one filter's check does. Such a group finds nothing, and the
 * groups of the same operator inside it are not searched either.
 */
const OPPOSED_TERMS = 1024;

/**
 * At most this many pairs of terms without a key (groups, subqueries,
 * arithmetic and other expressions) are compared in full with sameExpression() in one group's search, as each
 * comparison walks both conditions; pairs past it are not found there.
 */
const COMPARED_TERMS = 256;

/** The terms of one key, by sign. */
type Signs = { yes?: Term; no?: Term };

/**
 * The numbers one operand's terms admit together: an OR admits what any term
 * admits, an AND what no term leaves out. Each term's numbers wait in
 * `added` until decided() needs them joined; an AND joins what its terms
 * leave out (`x <> 5` leaves out one number), so a term costs the same in
 * both.
 */
type Bounds = {
  readonly operand: ValueNode;
  /** Joined: the numbers any term admits (OR) or leaves out (AND). */
  intervals: readonly Interval[];
  /** The numbers each term added since they were last joined admits. */
  readonly added: (readonly Interval[])[];
  /** Whether the intervals reach below every number, and above it. */
  below: boolean;
  above: boolean;
};

/**
 * A group's terms that no bound value changes, searched once, and those the
 * values of each execution decide.
 */
type Index = {
  readonly fixed: Opposition;
  readonly keyed: ReadonlyMap<string, Signs>;
  readonly bounds: ReadonlyMap<string, Bounds>;
  readonly live: readonly PredicateDescription[];
  /** Groups searched with the fixed terms, whose range the values decide. */
  readonly ranged: readonly PredicateDescription[];
  /**
   * Whether the search finds whatever the search of a group among its terms
   * finds (one it collects as its own below an even number of not()s), so
   * that group below not()s needs no search of its own (see IN_TERMS). Not
   * when the group has too many terms to search (OPPOSED_TERMS), used up its
   * COMPARED_TERMS comparisons, or holds terms of one key and sign of which
   * one is an `IS [NOT] DISTINCT FROM` of a value and another is not (or may
   * be, at some values): only the first of them is kept, so whether a pair
   * holds where its values are NULL depends on which comes first.
   */
  readonly covers: boolean;
  /** Whether the values of an execution can add to what the fixed terms find (see valuesDecide()). */
  readonly changes: boolean;
  /**
   * A parameter that the terms the values decide compare with: read when
   * oppositionOf() takes the search from this check's cache, so that a
   * prepared write still sees the group consult a value (see residualOf()).
   */
  readonly consults?: PlaceholderNode;
};

const NO_OPPOSITION: Opposition = Object.freeze({ pairs: [], ranges: [] });

/**
 * The index of a group whose search can find nothing: fewer than two terms,
 * terms that test one column each, terms whose operators allow no pair and no
 * range (see searchable()), or is(null) of a NOT NULL jsonb column.
 */
const NO_INDEX: Index = Object.freeze({
  fixed: NO_OPPOSITION,
  keyed: new Map(),
  bounds: new Map(),
  live: [],
  ranged: [],
  covers: true,
  changes: false,
});

/** A group of too many terms to search. */
const UNSEARCHED: Index = Object.freeze({ ...NO_INDEX, covers: false });

/** The analysis that reads terms without parameters, which consult no value. */
const UNBOUND: Analysis = Object.freeze({ roots: [] });

/** UNBOUND for terms read for their keys alone, without ranges. */
const RANGELESS: Analysis = Object.freeze({ roots: [] });

const indexes = new WeakMap<GroupDescription, Index>();

/**
 * Keeps a term under its key and sign, unless a term is kept there already
 * (the first one stays); true when it is kept and the key holds both signs.
 */
const signed = (
  keyed: Map<string, Signs>,
  term: Term,
  key: string,
): boolean => {
  let signs = keyed.get(key);

  if (!signs) {
    signs = {};
    keyed.set(key, signs);
  }

  if (term.sign ? signs.yes : signs.no) {
    return false;
  }

  if (term.sign) {
    signs.yes = term;
  } else {
    signs.no = term;
  }

  return !!(term.sign ? signs.no : signs.yes);
};

/**
 * Adds the numbers a term admits to its operand's bounds, to be joined by
 * decided(), and notes the ends that what it admits (OR) or leaves out (AND)
 * reaches.
 */
const bounded = (
  operator: GroupDescription["operator"],
  bounds: Map<string, Bounds>,
  range: Range,
  fixed?: ReadonlyMap<string, Bounds>,
): void => {
  let entry = bounds.get(range.key);

  if (!entry) {
    // From the terms no value changes, whose own entry stays as it is.
    const start = fixed?.get(range.key);

    entry = {
      operand: range.operand,
      intervals: start?.intervals ?? [],
      added: start ? [...start.added] : [],
      below: !!start?.below,
      above: !!start?.above,
    };
    bounds.set(range.key, entry);
  }

  const { intervals } = range;
  // What an AND's term leaves out reaches an end its numbers do not.
  const below = intervals[0]?.from === -Infinity;
  const above = intervals[intervals.length - 1]?.to === Infinity;

  entry.added.push(intervals);
  entry.below ||= operator === "OR" ? below : !below;
  entry.above ||= operator === "OR" ? above : !above;
};

/** Whether intervals in order, apart, hold a number. */
const holds = (intervals: readonly Interval[], value: number): boolean => {
  let low = 0;
  let high = intervals.length;

  // The first interval that does not end below the number.
  while (low < high) {
    const middle = (low + high) >> 1;
    const { to, toIn } = intervals[middle]!;

    if (to < value || (to === value && !toIn)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const found = intervals[low];

  return (
    !!found && (value > found.from || (value === found.from && found.fromIn))
  );
};

/** A number in an interval (that holds one), or undefined. */
const numberIn = (interval: Interval): number | undefined => {
  const { from, fromIn, to, toIn } = interval;
  const value = fromIn
    ? from
    : toIn
      ? to
      : from === -Infinity
        ? to === Infinity
          ? 0
          : to - 1
        : to === Infinity
          ? from + 1
          : from + (to - from) / 2;

  // Far from 0, a number and its neighbour can be one.
  return holds([interval], value) ? value : undefined;
};

/** The first `limit` intervals of complement(intervals), without the rest. */
const firstGaps = (
  intervals: readonly Interval[],
  limit: number,
): Interval[] => {
  const gaps: Interval[] = [];
  let from = -Infinity;
  let fromIn = false;

  for (const interval of intervals) {
    if (gaps.length >= limit) {
      return gaps;
    }

    const gap = { from, fromIn, to: interval.from, toIn: !interval.fromIn };

    if (!hollow(gap)) {
      gaps.push(gap);
    }

    from = interval.to;
    fromIn = !interval.toIn;
  }

  if (gaps.length < limit && from !== Infinity) {
    gaps.push({ from, fromIn, to: Infinity, toIn: false });
  }

  return gaps;
};

/** At most this many terms of one operand are first tried for a number they leave undecided. */
const WITNESS_TERMS = 8;

/** At most this many numbers are tried. */
const WITNESSES = 4;

/**
 * Whether a number shows that an operand's terms admit not every number (OR:
 * one no term admits) or some number (AND: one every term admits), found
 * without joining all their numbers; false when none of the few tried shows
 * it.
 */
const witnessed = (
  operator: GroupDescription["operator"],
  entry: Bounds,
): boolean => {
  const { added } = entry;
  const first = added[0];

  if (!first || added.length > WITNESS_TERMS) {
    return false;
  }

  // OR: numbers the first term leaves out; AND: numbers it admits.
  const candidates = operator === "OR" ? firstGaps(first, WITNESSES) : first;
  const tried = Math.min(candidates.length, WITNESSES);
  const admitted = operator === "AND";

  for (let index = 0; index < tried; index += 1) {
    const value = numberIn(candidates[index]!);

    // Joined, the numbers any term admits (OR) or leaves out (AND).
    if (value === undefined || holds(entry.intervals, value)) {
      continue;
    }

    let shown = true;

    for (let other = 1; other < added.length && shown; other += 1) {
      shown = holds(added[other]!, value) === admitted;
    }

    if (shown) {
      return true;
    }
  }

  return false;
};

/**
 * Whether an operand's terms admit every number (OR) or none (AND): what
 * they admit, or leave out, covers every number. The numbers are joined in
 * order once all are added, unless a number found first shows otherwise.
 */
const decided = (
  operator: GroupDescription["operator"],
  entry: Bounds,
): boolean => {
  // Numbers without end both ways take a piece without end each way.
  if (!entry.below || !entry.above) {
    return false;
  }

  if (entry.added.length) {
    if (witnessed(operator, entry)) {
      return false;
    }

    const pieces = [...entry.intervals];

    for (const intervals of entry.added) {
      for (const interval of operator === "OR"
        ? intervals
        : complement(intervals)) {
        pieces.push(interval);
      }
    }

    entry.intervals = union(pieces);
    entry.added.length = 0;
  }

  return everyNumber(entry.intervals);
};

/** Whether a pair decides its group where its values are NULL too. */
const certainly = (
  operator: GroupDescription["operator"],
  first: Term,
  second: Term | undefined,
): boolean =>
  first.onNull === (operator === "OR") ||
  second?.onNull === (operator === "OR");

/** testedColumn() of groups with groups or negations in them, found once (null for none). */
const testedColumns = new WeakMap<GroupDescription, object | null>();

/**
 * The column a condition tests, for a quick look whether two conditions can
 * meet; undefined when it is not one column (a group, a subquery).
 */
const testedColumn = (
  description: PredicateDescription,
): object | undefined => {
  const current = written(description);

  // Only a group of groups is read again for each group around it.
  if (current.kind !== "group" || flat(current)) {
    return columnTested(current);
  }

  const cached = testedColumns.get(current);

  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const found = columnTested(current);

  testedColumns.set(current, found ?? null);

  return found;
};

/** The column a value is, or reads through JSON null, a cast to text or a JSON path. */
const columnOf = (node: ValueNode): object | undefined => {
  const inner =
    node.kind === "raw"
      ? (jsonNullInner(node) ?? castInner(node, "text"))
      : node.kind === "jsonPath"
        ? node.value
        : node;

  return inner?.kind === "column"
    ? inner.description.column
    : inner && inner !== node
      ? columnOf(inner)
      : undefined;
};

/** testedColumn() of a condition as written. */
const columnTested = (current: PredicateDescription): object | undefined => {
  switch (current.kind) {
    case "not":
    case "notTrue":
      return testedColumn(current.predicate);
    case "comparison":
      return columnOf(current.left);
    case "nullCheck":
    case "membership":
    case "between":
      return columnOf(current.value);
    case "group": {
      const value = jsonNullTested(current);

      if (value) {
        return columnOf(value);
      }

      // A group whose conditions all test one column tests that column.
      let found: object | undefined;

      if (current.predicates.length > RANGE_TERMS) {
        return undefined;
      }

      for (const child of current.predicates) {
        const tested = testedColumn(child);

        if (!tested || (found && tested !== found)) {
          return undefined;
        }

        found = tested;
      }

      return found;
    }
    default:
      return undefined;
  }
};

/** A group, below not()s or not. */
const grouped = (description: PredicateDescription): boolean => {
  const current = written(description);

  return current.kind === "not" || current.kind === "notTrue"
    ? grouped(current.predicate)
    : current.kind === "group";
};

/**
 * Terms that test one column each, every column once: no two of them can be
 * opposites or ranges of one operand, so the group needs no search.
 */
const apart = (terms: readonly PredicateDescription[]): boolean => {
  const seen: object[] = [];

  // The other conditions first: a column they test twice answers without
  // reading the groups.
  for (const groups of [false, true]) {
    for (const description of terms) {
      if (grouped(description) !== groups) {
        continue;
      }

      const column = testedColumn(description);

      if (!column || seen.includes(column)) {
        return false;
      }

      seen.push(column);
    }
  }

  return true;
};

/**
 * A group whose conditions an AND or OR of `operator` collects as its own
 * (see termsOf()), below an odd number of not()s with `negate`.
 */
const spreadsInto = (
  current: PredicateDescription,
  operator: GroupDescription["operator"],
  negate: boolean,
): current is GroupDescription =>
  current.kind === "group" &&
  (negate ? dual(current.operator) : current.operator) === operator &&
  !jsonNullTested(current);

/** A group's terms, and those of them kept whole beside the terms they spread into. */
type Collected = {
  readonly terms: readonly PredicateDescription[];
  readonly wholes: ReadonlySet<PredicateDescription>;
};

const NO_WHOLES: ReadonlySet<PredicateDescription> = new Set();

/**
 * The conditions an AND or OR searches as its own: those of nested groups of
 * the same operator, and by De Morgan those of the other operator below a
 * not() (in an OR, `not(and(a, b))` is `not(a)` and `not(b)`). Undefined for
 * more than `limit` of them.
 */
const termsOf = (
  group: GroupDescription,
  limit = Infinity,
): Collected | undefined => {
  // Conditions that are neither groups nor negations are the terms as they are.
  if (
    group.predicates.every((child) => {
      const current = written(child);

      return current.kind !== "group" && current.kind !== "not";
    })
  ) {
    return group.predicates.length > limit
      ? undefined
      : { terms: group.predicates, wholes: NO_WHOLES };
  }

  const terms: PredicateDescription[] = [];
  let wholes: Set<PredicateDescription> | undefined;
  const collect = (description: PredicateDescription, negate: boolean) => {
    // Past the limit, the rest is not collected.
    if (terms.length > limit) {
      return;
    }

    const current = written(description);

    if (current.kind === "not") {
      if (negate) {
        collect(current.predicate, false);
      } else {
        // Kept whole too, as the opposite of the same group written plainly.
        terms.push(description);

        if (spreadsInto(written(current.predicate), group.operator, true)) {
          wholes ??= new Set();
          wholes.add(description);
          collect(current.predicate, true);
        }
      }
    } else if (spreadsInto(current, group.operator, negate)) {
      for (const child of current.predicates) {
        collect(child, negate);
      }
    } else {
      terms.push(
        negate ? freeze({ kind: "not", predicate: description }) : description,
      );
    }
  };

  for (const child of group.predicates) {
    collect(child, false);
  }

  return terms.length > limit
    ? undefined
    : { terms, wholes: wholes ?? NO_WHOLES };
};

/** How many terms termsOf() collects from a group it spreads, by operator and sign, found once. */
const termCounts = new WeakMap<GroupDescription, number[]>();

/** How many terms termsOf() collects from a condition (see collect() there). */
const termCount = (
  description: PredicateDescription,
  operator: GroupDescription["operator"],
  negate: boolean,
): number => {
  const current = written(description);

  if (current.kind === "not") {
    return negate
      ? termCount(current.predicate, operator, false)
      : spreadsInto(written(current.predicate), operator, true)
        ? 1 + termCount(current.predicate, operator, true)
        : 1;
  }

  if (!spreadsInto(current, operator, negate)) {
    return 1;
  }

  const position = (operator === "OR" ? 2 : 0) + (negate ? 1 : 0);
  const cached = termCounts.get(current)?.[position];

  if (cached !== undefined) {
    return cached;
  }

  let count = 0;

  for (const child of current.predicates) {
    count += termCount(child, operator, negate);
  }

  let entry = termCounts.get(current);

  if (!entry) {
    entry = [];
    termCounts.set(current, entry);
  }

  entry[position] = count;

  return count;
};

/**
 * The term of a group kept whole beside the terms it spreads into (see
 * termsOf()): `not(G)`, compared in full with the other terms. Its range is
 * theirs together, so it adds none.
 */
const wholeTerm = (description: PredicateDescription): Term => {
  const negation = written(description) as Extract<
    PredicateDescription,
    { kind: "not" }
  >;

  return plainTerm(written(negation.predicate), false);
};

/**
 * An `IS [NOT] DISTINCT FROM`, below not()s or not, whose pair can decide its
 * group where its values are NULL too (see certainly()).
 */
const distinctComparison = (description: PredicateDescription): boolean => {
  const current = written(description);

  return current.kind === "not" || current.kind === "notTrue"
    ? distinctComparison(current.predicate)
    : current.kind === "comparison" &&
        (current.operator === "IS DISTINCT FROM" ||
          current.operator === "IS NOT DISTINCT FROM");
};

const dual = (
  operator: GroupDescription["operator"],
): GroupDescription["operator"] => (operator === "AND" ? "OR" : "AND");

/** Sign bits of the terms of one family of keys. */
const POSITIVE = 1;
const NEGATIVE = 2;

/** The bits of the other sign. */
const opposite = (signs: number): number =>
  ((signs & POSITIVE) << 1) | ((signs & NEGATIVE) >> 1);

/**
 * The family of a term's key: the key without the value it compares with,
 * which a pair shares: the operator and operand of a comparison, the operand
 * of a list or a between(); a NULL test's key has no value.
 */
const termFamily = (term: Term): string | undefined => {
  const { base } = term;

  if (term.key === undefined) {
    return undefined;
  }

  switch (base.kind) {
    case "comparison": {
      // IS NOT DISTINCT FROM a value is `=` of the operand's JSON null as NULL.
      const distinct =
        term.operator === "=" &&
        (base.operator === "IS DISTINCT FROM" ||
          base.operator === "IS NOT DISTINCT FROM");

      return `${term.operator}\u0002${operandKey(distinct ? (jsonNullInner(base.left) ?? base.left) : base.left)}`;
    }
    case "membership":
      return `m\u0002${operandKey(base.value)}`;
    case "between":
      return `b\u0002${operandKey(base.value)}`;
    default:
      return term.key;
  }
};

/** A parameter a condition compares with, outside its subqueries. */
const placeholderOf = (
  description: PredicateDescription,
): PlaceholderNode | undefined => {
  const current = written(description);
  const bound = (node: ValueNode) => {
    const found = boundNode(node);

    return found?.kind === "placeholder" ? found : undefined;
  };

  switch (current.kind) {
    case "not":
    case "notTrue":
      return placeholderOf(current.predicate);
    case "group":
      for (const child of current.predicates) {
        const found = placeholderOf(child);

        if (found) {
          return found;
        }
      }

      return undefined;
    case "comparison":
      return bound(current.right);
    case "membership":
      return Array.isArray(current.values)
        ? (current.values as readonly ValueNode[])
            .map(bound)
            .find((node) => node)
        : undefined;
    case "between":
      return bound(current.lower) ?? bound(current.upper);
    default:
      return undefined;
  }
};

/**
 * Whether a value may be `false` (anything but a parameter of a number type),
 * which makes `flag = p` the opposite of `flag = true`.
 */
const mayBindFalse = (node: ValueNode): boolean => {
  const bound = boundNode(node);

  return (
    bound?.kind !== "placeholder" ||
    !orderedNumber((bound as PlaceholderNode).sqlType)
  );
};

/**
 * The families of keys (see termFamily()) that a term the bound values
 * decide can have at some values, each with the signs it can have there.
 */
const valuedFamilies = (
  description: PredicateDescription,
  sign: boolean,
  add: (family: string, signs: number) => void,
): void => {
  const current = written(description);
  const either = POSITIVE | NEGATIVE;
  const signOf = (positive: boolean) => (positive ? POSITIVE : NEGATIVE);
  // Bound to null, a comparison tests its operand for NULL.
  const nullTests = (node: ValueNode) => {
    for (const operand of [node, jsonNullInner(node) ?? node]) {
      const key = operandKey(operand);

      if (key !== undefined) {
        add(`n${key}`, either);
        add(`j${key}`, either);
      }
    }
  };

  switch (current.kind) {
    case "not":
    case "notTrue":
      valuedFamilies(current.predicate, !sign, add);
      break;
    case "comparison": {
      const { left, right } = current;
      const opposed = OPPOSITES[current.operator];
      const operator = opposed ?? current.operator;
      const signed = opposed ? !sign : sign;
      const flips = (positive: boolean) =>
        mayBindFalse(right) ? either : signOf(positive);

      if (current.nullableParameter) {
        nullTests(left);
      }

      if (operator === "IS NOT DISTINCT FROM") {
        nullTests(left);

        const key = operandKey(left);
        const inner = operandKey(jsonNullInner(left) ?? left);

        if (key !== undefined) {
          add(`${operator}\u0002${key}`, signOf(signed));
        }

        if (inner !== undefined) {
          add(`=\u0002${inner}`, flips(signed));
        }
      } else {
        const key = operandKey(left);

        if (key !== undefined) {
          add(
            `${operator}\u0002${key}`,
            operator === "=" ? flips(signed) : signOf(signed),
          );
        }
      }
      break;
    }
    case "membership": {
      const key = operandKey(current.value);

      if (key !== undefined) {
        add(`=\u0002${key}`, either);
        add(`m\u0002${key}`, signOf(current.negated ? !sign : sign));
      }
      break;
    }
    case "between": {
      const key = operandKey(current.value);

      if (key !== undefined) {
        add(`b\u0002${key}`, signOf(sign));
      }
      break;
    }
    default:
      break;
  }
};

/**
 * Bits of where the numbers a term admits of an operand reach at any values
 * that give it a range: below every number (REACH_BELOW) or not
 * (MISS_BELOW), above every number or not.
 */
const REACH_BELOW = 1;
const MISS_BELOW = 2;
const REACH_ABOVE = 4;
const MISS_ABOVE = 8;

/** The ends a range reaches. */
type Reach = { readonly key: string; readonly bits: number };

/** reachOf() of groups by sign, found once (null for none). */
const groupReaches = new WeakMap<GroupDescription, (Reach | null)[]>();

/** The ends `x < n` (`"<"`), `x > n` (`">"`) or `x = n` (`"="`) reaches, or with `sign` false its opposite. */
const reachOfOperator = (operator: string, sign: boolean): number =>
  operator === "="
    ? sign
      ? MISS_BELOW | MISS_ABOVE
      : REACH_BELOW | REACH_ABOVE
    : (operator === "<") === sign
      ? REACH_BELOW | MISS_ABOVE
      : MISS_BELOW | REACH_ABOVE;

/**
 * Where the range of a term reaches, at any values that give it one, read
 * from its operators alone: for the terms the bound values decide (see
 * valuesDecide()) and for a first look at a group's terms (see searchable()).
 * With `top` the term is read as termOf() reads it, which also gives a range
 * to a list of one value written more than once; otherwise as rangeOf() does.
 */
const reachOf = (
  description: PredicateDescription,
  sign: boolean,
  top = false,
): Reach | undefined => {
  const current = written(description);

  switch (current.kind) {
    case "not":
    case "notTrue":
      return reachOf(current.predicate, !sign, top);
    case "group": {
      if (current.predicates.length > RANGE_TERMS || jsonNullTested(current)) {
        return undefined;
      }

      const position = sign ? 1 : 0;
      const cached = groupReaches.get(current)?.[position];

      if (cached !== undefined) {
        return cached ?? undefined;
      }

      // An intersection reaches an end that every part reaches, a union one
      // that any part does.
      const every = (current.operator === "AND") === sign;
      let key: string | undefined;
      let below = every;
      let above = every;
      let found: Reach | undefined;

      for (const child of current.predicates) {
        const part = reachOf(child, sign);

        if (!part || (key !== undefined && part.key !== key)) {
          key = undefined;
          break;
        }

        key = part.key;
        below = every
          ? below && (part.bits & REACH_BELOW) !== 0
          : below || (part.bits & REACH_BELOW) !== 0;
        above = every
          ? above && (part.bits & REACH_ABOVE) !== 0
          : above || (part.bits & REACH_ABOVE) !== 0;
      }

      if (key !== undefined) {
        found = {
          key,
          bits:
            (below ? REACH_BELOW : MISS_BELOW) |
            (above ? REACH_ABOVE : MISS_ABOVE),
        };
      }

      let entry = groupReaches.get(current);

      if (!entry) {
        entry = [];
        groupReaches.set(current, entry);
      }

      entry[position] = found ?? null;

      return found;
    }
    case "between": {
      const key = operandKey(current.value);

      return key !== undefined && orderedNumber(sqlTypeOf(current.value))
        ? {
            key,
            bits: sign ? MISS_BELOW | MISS_ABOVE : REACH_BELOW | REACH_ABOVE,
          }
        : undefined;
    }
    case "membership": {
      const values = current.values;

      // rangeOf() reads a list of one value, termOf() one of one value
      // written more than once too.
      if (
        !Array.isArray(values) ||
        !values.length ||
        (!top && values.length !== 1)
      ) {
        return undefined;
      }

      const key = operandKey(current.value);

      return key !== undefined && orderedNumber(sqlTypeOf(current.value))
        ? {
            key,
            bits: reachOfOperator("=", current.negated ? !sign : sign),
          }
        : undefined;
    }
    case "comparison": {
      const opposed = OPPOSITES[current.operator];
      const operator = opposed ?? current.operator;
      const signed = opposed ? !sign : sign;
      // IS NOT DISTINCT FROM a number is `=` of the operand's JSON null as NULL.
      const distinct = operator === "IS NOT DISTINCT FROM";

      if (
        !(
          distinct ||
          operator === "<" ||
          operator === ">" ||
          operator === "="
        ) ||
        !orderedNumber(sqlTypeOf(current.left))
      ) {
        return undefined;
      }

      const key = operandKey(
        distinct ? (jsonNullInner(current.left) ?? current.left) : current.left,
      );

      return key === undefined
        ? undefined
        : { key, bits: reachOfOperator(distinct ? "=" : operator, signed) };
    }
    default:
      return undefined;
  }
};

/** At most this many conditions without groups are searched without reading them first. */
const FEW_TERMS = 8;

/** What a group's search can find at any values (see searchable()). */
type Searchable = {
  /** A pair: false when none can be, undefined when the terms do not tell. */
  readonly pairs: boolean | undefined;
  /** A range that decides the group. */
  readonly ranges: boolean;
};

/**
 * What a group's search can find at any values, read from the operators
 * alone before any key or range is built. A pair: where every term is a
 * group or a column compared with `<`, `>`, `<=`, `>=`, `=` or `<>`, only two
 * groups of both signs, or two terms of one operator and column with both
 * signs (for `=`, of one value written out, or a parameter), can make one;
 * other terms leave it open. A range: where terms of one operand admit
 * numbers that reach both ends (an OR's) or leave out numbers at both (an
 * AND's).
 */
const searchable = (
  operator: GroupDescription["operator"],
  terms: readonly PredicateDescription[],
  wholes: ReadonlySet<PredicateDescription>,
): Searchable => {
  const both = POSITIVE | NEGATIVE;
  const signs = new Map<string, number>();
  const [below, above] =
    operator === "OR" ? [REACH_BELOW, REACH_ABOVE] : [MISS_BELOW, MISS_ABOVE];
  const ends = new Map<string, number>();
  let pairs: boolean | undefined = false;
  let ranges = false;
  // The `=` terms of each column, by the value they compare with (undefined
  // for a parameter, or for a term that may have either sign) and sign.
  const equals = new Map<string, [string | undefined, number][]>();

  for (const description of terms) {
    const whole = wholes.has(description);

    // A term kept whole has the range of the terms it spreads into.
    if (!ranges && !whole) {
      const reach = reachOf(description, true, true);

      if (reach) {
        const reached =
          (ends.get(reach.key) ?? 0) |
          (reach.bits & below ? REACH_BELOW : 0) |
          (reach.bits & above ? REACH_ABOVE : 0);

        ranges = reached === (REACH_BELOW | REACH_ABOVE);
        ends.set(reach.key, reached);
      }
    }

    if (pairs !== false) {
      if (ranges) {
        break;
      }

      continue;
    }

    let current = written(description);
    let sign = true;

    while (current.kind === "not" || current.kind === "notTrue") {
      sign = !sign;
      current = written(current.predicate);
    }

    let family: string;
    let signed: number;

    if (whole || (current.kind === "group" && !jsonNullTested(current))) {
      family = "\u0003group";
      signed = sign ? POSITIVE : NEGATIVE;
    } else if (
      current.kind === "comparison" &&
      current.left.kind === "column" &&
      !current.nullableParameter &&
      (current.operator === "<" ||
        current.operator === ">" ||
        current.operator === "<=" ||
        current.operator === ">=" ||
        current.operator === "=" ||
        current.operator === "<>")
    ) {
      const opposed = OPPOSITES[current.operator];
      const positive = opposed ? !sign : sign;
      const normal = opposed ?? current.operator;
      const { right } = current;

      family = `${normal}${operandKey(current.left)}`;
      // `flag = false` is NOT `flag = true` (see comparisonTerm()).
      signed =
        normal === "=" &&
        (right.kind === "parameter"
          ? right.value === false
          : mayBindFalse(right) && right.kind !== "column")
          ? both
          : positive
            ? POSITIVE
            : NEGATIVE;
    } else {
      pairs = undefined;
      continue;
    }

    const kept = (signs.get(family) ?? 0) | signed;

    signs.set(family, kept);

    if (current.kind === "comparison" && family.startsWith("=")) {
      // Of `=` with values written out, only one value with both signs is a
      // pair; one a parameter binds may be any value.
      const value =
        current.right.kind === "placeholder" || signed === both
          ? undefined
          : valueKey(current.right, RANGELESS);
      const entry = equals.get(family);

      if (entry) {
        entry.push([value, signed]);
      } else {
        equals.set(family, [[value, signed]]);
      }
    } else if (kept === both) {
      pairs = true;
    }
  }

  if (pairs === false) {
    for (const [family, entries] of equals) {
      if (signs.get(family) !== both) {
        continue;
      }

      // A parameter or a value without a key may meet any of them.
      if (entries.some(([value]) => value === undefined)) {
        pairs = undefined;
        break;
      }

      const paired = new Map<string, number>();

      for (const [value, signed] of entries) {
        const kept = (paired.get(value!) ?? 0) | signed;

        if (kept === both) {
          pairs = true;
          break;
        }

        paired.set(value!, kept);
      }

      if (pairs) {
        break;
      }
    }
  }

  return { pairs, ranges };
};

/**
 * Whether the terms the bound values decide can, at some values, add a pair
 * or decide a range in a group's search: a fixed term of their key's family
 * with the other sign, two of them in one family that can have both signs,
 * or terms of one operand, with the fixed ones, whose numbers reach both ends
 * (an OR's) or leave out numbers at both (an AND's).
 */
const valuesDecide = (
  operator: GroupDescription["operator"],
  keyed: ReadonlyMap<string, Signs>,
  bounds: ReadonlyMap<string, Bounds>,
  live: readonly PredicateDescription[],
  ranged: readonly PredicateDescription[],
): boolean => {
  if (live.length) {
    const fixed = new Map<string, number>();
    const valued = new Map<string, { signs: number; count: number }>();

    for (const signs of keyed.values()) {
      for (const term of [signs.yes, signs.no]) {
        const family = term && termFamily(term);

        if (family !== undefined) {
          fixed.set(
            family,
            (fixed.get(family) ?? 0) | (term!.sign ? POSITIVE : NEGATIVE),
          );
        }
      }
    }

    for (const description of live) {
      valuedFamilies(description, true, (family, signs) => {
        const entry = valued.get(family);

        if (entry) {
          entry.signs |= signs;
          entry.count += 1;
        } else {
          valued.set(family, { signs, count: 1 });
        }
      });
    }

    for (const [family, { signs, count }] of valued) {
      if (
        ((fixed.get(family) ?? 0) & opposite(signs)) !== 0 ||
        (count > 1 && signs === (POSITIVE | NEGATIVE))
      ) {
        return true;
      }
    }
  }

  // What an AND's term leaves out reaches an end its numbers miss.
  const [below, above] =
    operator === "OR" ? [REACH_BELOW, REACH_ABOVE] : [MISS_BELOW, MISS_ABOVE];
  const ends = new Map<string, number>();

  for (const description of [...live, ...ranged]) {
    const reach = reachOf(description, true, true);

    if (reach) {
      const start = bounds.get(reach.key);
      const reached =
        (ends.get(reach.key) ??
          (start?.below ? REACH_BELOW : 0) | (start?.above ? REACH_ABOVE : 0)) |
        (reach.bits & below ? REACH_BELOW : 0) |
        (reach.bits & above ? REACH_ABOVE : 0);

      if (reached === (REACH_BELOW | REACH_ABOVE)) {
        return true;
      }

      ends.set(reach.key, reached);
    }
  }

  return false;
};

/**
 * The terms of a group (see termsOf()), filed by key: each key's two signs
 * and each operand's bounds are found in one pass, and terms without a key
 * are compared in full, up to COMPARED_TERMS comparisons. Terms the bound
 * values decide are set apart, for oppositionOf() to read with each
 * execution's values.
 */
const indexOf = (group: GroupDescription): Index => {
  const cached = indexes.get(group);

  if (cached) {
    return cached;
  }

  // is(null) of a NOT NULL jsonb column is one condition.
  if (jsonNullTested(group)) {
    indexes.set(group, NO_INDEX);

    return NO_INDEX;
  }

  // A group of too many terms is collected up to the limit and then counted
  // in full, once, with the groups it spreads into: those are often too many
  // as well (a deep chain of not()s), and their counts spare them collecting
  // up to the limit again.
  const counted = termCounts.get(group)?.[group.operator === "OR" ? 2 : 0];
  const collected =
    counted !== undefined && counted > OPPOSED_TERMS
      ? undefined
      : termsOf(group, OPPOSED_TERMS);

  if (!collected) {
    termCount(group, group.operator, false);
    indexes.set(group, UNSEARCHED);

    return UNSEARCHED;
  }

  const { terms, wholes } = collected;

  // A few conditions without groups are searched as they are: reading
  // them first saves nothing.
  const found =
    terms.length < 2 || apart(terms)
      ? undefined
      : terms.length <= FEW_TERMS && !terms.some(grouped)
        ? { pairs: undefined, ranges: true }
        : searchable(group.operator, terms, wholes);

  if (!found || (found.pairs === false && !found.ranges)) {
    indexes.set(group, NO_INDEX);

    return NO_INDEX;
  }

  const keyed = new Map<string, Signs>();
  const bounds = new Map<string, Bounds>();
  const pairs: PredicateDescription[] = [];
  const ranges: ValueNode[] = [];
  // Terms without a key by sign and kind, in order: only opposite signs of
  // one kind are compared.
  const unkeyed = new Map<string, PredicateDescription[][]>();
  const live: PredicateDescription[] = [];
  const ranged: PredicateDescription[] = [];
  let comparisons = 0;
  let certain = false;
  // Terms of one key and sign that read NULL apart (see Index.covers), and
  // the families of the terms that decide where their values are NULL.
  let mixed = false;
  const nullDeciding = new Set<string>();
  // Ranges that cannot decide anything are not built.
  const reading = found.ranges ? UNBOUND : RANGELESS;

  for (const description of terms) {
    if (dependsOnValues(description)) {
      // An IS [NOT] DISTINCT FROM reads NULL by the value it binds.
      mixed ||= distinctComparison(description);
      live.push(description);
      continue;
    }

    const whole = wholes.has(description);
    const term = whole ? wholeTerm(description) : termOf(description, reading);

    if (!whole && reading === UNBOUND && rangedByValues(description)) {
      ranged.push(description);
    }

    if (term.key !== undefined) {
      if (signed(keyed, term, term.key)) {
        pairs.push(coreOf(term));
        certain ||= certainly(
          group.operator,
          term,
          keyed.get(term.key)![term.sign ? "no" : "yes"],
        );
      }

      mixed ||=
        keyed.get(term.key)![term.sign ? "yes" : "no"]!.onNull !== term.onNull;

      if (term.onNull !== undefined) {
        nullDeciding.add(termFamily(term)!);
      }
    } else {
      const core = coreOf(term);

      let kinds = unkeyed.get(core.kind);

      if (!kinds) {
        kinds = [[], []];
        unkeyed.set(core.kind, kinds);
      }

      for (const other of kinds[term.sign ? 0 : 1]!) {
        if (comparisons >= COMPARED_TERMS) {
          break;
        }

        comparisons += 1;

        if (sameExpression([other], [core])) {
          pairs.push(core);
          break;
        }
      }

      kinds[term.sign ? 1 : 0]!.push(core);
    }

    if (term.range) {
      bounded(group.operator, bounds, term.range);
    }
  }

  for (const entry of bounds.values()) {
    if (decided(group.operator, entry)) {
      ranges.push(entry.operand);
    }
  }

  // A term the values decide may take the key of one that decides where
  // its values are NULL.
  for (const description of mixed || !nullDeciding.size ? [] : live) {
    valuedFamilies(description, true, (family) => {
      mixed ||= nullDeciding.has(family);
    });
  }

  const consults =
    live.length || ranged.length
      ? [...live, ...ranged].map(placeholderOf).find((node) => node)
      : undefined;
  const index: Index = {
    fixed:
      pairs.length || ranges.length
        ? { pairs, ranges, ...(certain ? { certain: true as const } : {}) }
        : NO_OPPOSITION,
    keyed,
    bounds,
    live,
    ranged,
    covers: !mixed && comparisons < COMPARED_TERMS,
    changes:
      (live.length > 0 || ranged.length > 0) &&
      valuesDecide(group.operator, keyed, bounds, live, ranged),
    ...(consults ? { consults } : {}),
  };

  indexes.set(group, index);

  return index;
};

/**
 * A term of a group's search that is compared in full (it has no key) at
 * each execution of a prepared write: a term no value changes, with its
 * core and sign and whether it holds a parameter, or one the values decide
 * (`live`), whose core and sign they make.
 */
type Unkeyed =
  | {
      readonly core: PredicateDescription;
      readonly sign: boolean;
      readonly valued: boolean;
    }
  | { readonly live: PredicateDescription };

/**
 * The terms of a group without a key, in order, that the values of a
 * prepared write can make a pair of: a subquery, a relation quantifier, a
 * group or a count that holds a parameter, compared with sameExpression()
 * by identity where no value is known, is the same as another one at
 * values that write them alike (`or(posts.some((post) => post.views.is(a)),
 * posts.none((post) => post.views.is(b)))` with a = b).
 */
type Replay = {
  readonly terms: readonly Unkeyed[];
  /** A parameter they hold: read wherever the search is taken from the cache (see Index.consults). */
  readonly consults: PlaceholderNode;
};

/** replayOf() of groups, found once (null for none). */
const replays = new WeakMap<GroupDescription, Replay | null>();

/** What a term the values decide can be at some values when it has no key. */
const LIVE_KINDS = new Set([
  "comparison",
  "nullCheck",
  "group",
  "membership",
  "between",
]);

/**
 * The terms of a group without a key that the values of a prepared write
 * can make a pair of, for oppositionOf() to compare again with each
 * execution's values; undefined when no values can (see sameUnder()).
 */
const replayOf = (
  group: GroupDescription,
  index: Index,
): Replay | undefined => {
  const cached = replays.get(group);

  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const collected =
    index === NO_INDEX || index === UNSEARCHED
      ? undefined
      : termsOf(group, OPPOSED_TERMS);
  const terms: Unkeyed[] = [];
  let consults: PlaceholderNode | undefined;

  for (const description of collected?.terms ?? []) {
    if (dependsOnValues(description)) {
      // Its key is its operand's (see comparisonTerm()): one without a key
      // has none at any values.
      if (termOf(description, RANGELESS).key === undefined) {
        terms.push({ live: description });
        consults ??= placeholderOf(description);
      }

      continue;
    }

    const term = collected!.wholes.has(description)
      ? wholeTerm(description)
      : termOf(description, RANGELESS);

    if (term.key === undefined) {
      const core = coreOf(term);
      const held = placeholderIn(core);

      terms.push({ core, sign: term.sign, valued: !!held });
      consults ??= held;
    }
  }

  // Whether some values make two of them, one with a parameter, a pair; a
  // search of too many is taken to.
  let paired = false;
  let compared = 0;

  for (let second = 1; second < terms.length && !paired; second += 1) {
    const later = terms[second]!;

    for (let first = 0; first < second && !paired; first += 1) {
      const earlier = terms[first]!;

      if ("live" in earlier || "live" in later) {
        const other = "live" in earlier ? later : earlier;

        paired = "live" in other || LIVE_KINDS.has(other.core.kind);
      } else if (
        (earlier.valued || later.valued) &&
        earlier.sign !== later.sign &&
        earlier.core.kind === later.core.kind
      ) {
        compared += 1;
        paired =
          compared > COMPARED_TERMS ||
          sameUnder(earlier.core, later.core, ANY_VALUES);
      }
    }
  }

  const replay = paired && consults ? { terms, consults } : undefined;

  replays.set(group, replay ?? null);

  return replay;
};

/** What a group's terms say together with the values of this analysis. */
const oppositionOf = (
  group: GroupDescription,
  analysis: Analysis,
): Opposition => {
  const index = indexOf(group);
  // Only a prepared write's values make its terms without a key a pair.
  const replay = analysis.bound ? replayOf(group, index) : undefined;

  // Without values that add to it, the search reads none.
  if (!index.changes && !replay) {
    return index.fixed;
  }

  const cached = analysis.oppositions?.get(group);

  if (cached) {
    // Found for this group elsewhere: a prepared write learns from the
    // values read which parts it checks again.
    if (index.consults) {
      analysis.bound?.(index.consults);
    }

    if (replay) {
      analysis.bound?.(replay.consults);
    }

    return cached;
  }

  const pairs = [...index.fixed.pairs];
  const ranges = [...index.fixed.ranges];
  const keyed = new Map<string, Signs>();
  const bounds = new Map<string, Bounds>();
  let certain = !!index.fixed.certain;

  if (replay) {
    // In the order of the search, as the same filter written with these
    // values compares them: with the same limit, where a term no value
    // changes is compared with another such term only there.
    const unkeyed = new Map<
      string,
      { core: PredicateDescription; valued: boolean; print?: string }[][]
    >();
    let comparisons = 0;
    const printOf = (entry: {
      core: PredicateDescription;
      print?: string;
    }): string => {
      entry.print ??= boundPrint(entry.core, analysis);

      return entry.print;
    };

    analysis.bound?.(replay.consults);

    for (const entry of replay.terms) {
      let core: PredicateDescription;
      let sign: boolean;
      let valued: boolean;

      if ("live" in entry) {
        if (analysis.inert?.has(written(entry.live))) {
          continue;
        }

        const term = termOf(entry.live, analysis);

        if (term.key !== undefined) {
          continue;
        }

        core = coreOf(term);
        sign = term.sign;
        valued = true;
      } else {
        ({ core, sign, valued } = entry);
      }

      let kinds = unkeyed.get(core.kind);

      if (!kinds) {
        kinds = [[], []];
        unkeyed.set(core.kind, kinds);
      }

      const current: {
        core: PredicateDescription;
        valued: boolean;
        print?: string;
      } = { core, valued };

      for (const other of kinds[sign ? 0 : 1]!) {
        if (comparisons >= COMPARED_TERMS) {
          break;
        }

        comparisons += 1;

        if (
          (valued || other.valued) &&
          printOf(other) === printOf(current) &&
          sameUnder(other.core, core, analysis)
        ) {
          pairs.push(core);
          break;
        }
      }

      kinds[sign ? 1 : 0]!.push(current);
    }
  }

  for (const description of index.changes ? index.live : []) {
    if (analysis.inert?.has(written(description))) {
      continue;
    }

    const term = termOf(description, analysis);

    if (term.key !== undefined) {
      const fixed = index.keyed.get(term.key);
      const partner = signed(keyed, term, term.key)
        ? keyed.get(term.key)![term.sign ? "no" : "yes"]
        : term.sign
          ? fixed?.no
          : fixed?.yes;

      if (partner) {
        pairs.push(coreOf(term));
        certain ||= certainly(group.operator, term, partner);
      }
    }

    if (term.range) {
      bounded(group.operator, bounds, term.range, index.bounds);
    }
  }

  for (const description of index.changes ? index.ranged : []) {
    const { range } = termOf(description, analysis);

    if (range) {
      bounded(group.operator, bounds, range, index.bounds);
    }
  }

  for (const entry of bounds.values()) {
    if (decided(group.operator, entry)) {
      ranges.push(entry.operand);
    }
  }

  const opposition = {
    pairs,
    ranges,
    ...(certain ? { certain: true as const } : {}),
  };

  analysis.oppositions?.set(group, opposition);

  return opposition;
};

/**
 * Whether an AND or OR holds a condition and its opposite (`x.is(null)` and
 * `x.isNot(null)`, `x.notIn([2])` and `x.is(2)`), or ranges of one operand
 * that cover every value (`or(id.atLeast(5), id.below(6))`) or, in an AND,
 * none, where the values compared are never NULL; or a pair that decides the
 * group where its values are NULL too (`or(x.isDistinctFrom(2), x.is(2))`).
 */
const opposed = (group: GroupDescription, analysis: Analysis): boolean => {
  const { pairs, ranges, certain } = oppositionOf(group, analysis);

  return (
    !!certain ||
    pairs.some((core) => twoValued(core, analysis)) ||
    ranges.some((operand) => definite(operand, analysis))
  );
};

/** At most this many values whose NULL a condition tests are tried both ways. */
const TRIED_VALUES = 3;

/** Keeps a value a condition tests for NULL, once, up to TRIED_VALUES. */
const testedValue = (found: ValueNode[], value: ValueNode): void => {
  if (
    found.length < TRIED_VALUES &&
    value.kind !== "parameter" &&
    value.kind !== "placeholder" &&
    !found.some((other) => sameValue(other, value))
  ) {
    found.push(value);
  }
};

/**
 * The values whose NULL a condition tests (`x IS NULL`, `x IS DISTINCT FROM
 * 2`), outside its subqueries.
 */
const nullTested = (
  description: PredicateDescription,
  analysis: Analysis,
  found: ValueNode[] = [],
): ValueNode[] => {
  const tested = (value: ValueNode) => testedValue(found, value);

  if (found.length >= TRIED_VALUES) {
    return found;
  }

  switch (description.kind) {
    case "group": {
      // The values each child tests are the same wherever it sits.
      const residual = analysis.assumed
        ? undefined
        : analysis.residuals?.get(description)?.find(Boolean);
      const { predicates } = description;

      for (let position = 0; position < predicates.length; position += 1) {
        const values = residual?.tested[position];

        if (values) {
          values.forEach(tested);
        } else {
          nullTested(predicates[position]!, analysis, found);
        }
      }
      break;
    }
    case "not":
    case "notTrue":
      nullTested(description.predicate, analysis, found);
      break;
    case "comparison": {
      const condition = written(description);

      if (condition !== description) {
        nullTested(condition, analysis, found);
        break;
      }

      const nulled = boundToNull(description, analysis);

      if (nulled) {
        nullTested(nulled, analysis, found);
      } else if (
        description.operator === "IS DISTINCT FROM" ||
        description.operator === "IS NOT DISTINCT FROM"
      ) {
        tested(description.left);
      }
      break;
    }
    case "nullCheck":
      tested(description.value);
      break;
    default:
      break;
  }

  return found;
};

/**
 * Splits a group of a prepared write's filter into the children that consult
 * no bound value, answered once, and the others; with the group's answer at
 * this analysis. Its children sit at `cover` and are read with `sense` (see
 * evaluate()); the groups among them are split too, once per place.
 */
const residualOf = (
  group: GroupDescription,
  analysis: Analysis,
  cover: number,
  sense: number,
): { readonly residual: Residual; readonly value: Truth } => {
  let consulted = false;
  const tracking: Analysis = {
    ...analysis,
    bound: (node) => {
      consulted = true;

      return analysis.bound?.(node);
    },
  };
  const values: Truth[] = [];
  const tested: (readonly ValueNode[] | undefined)[] = [];
  const live: PredicateDescription[] = [];
  let value: Truth = group.operator === "AND";

  for (const child of group.predicates) {
    consulted = false;

    const answer = evaluate(
      child,
      tracking,
      !!merged(child, group.operator),
      cover,
      sense,
    );

    value = combined(group.operator, value, answer);

    // A condition that tests a bound value for NULL consults it when read.
    const found = consulted ? undefined : nullTested(child, tracking);

    if (consulted) {
      live.push(child);
      tested.push(undefined);
    } else {
      values.push(answer);
      tested.push(found);
    }
  }

  return {
    residual: {
      fixed: group.operator === "AND" ? allOf(values) : anyOf(values),
      tested,
      live,
    },
    value,
  };
};

/**
 * Where a condition sits among the terms an AND or OR collects as its own
 * (see termsOf()), as bits of a number, 0 outside any: IN_TERMS inside one;
 * FRAME_OR when that group (the frame: the outermost group of the chain that
 * collects it) is an OR; NEGATED below an odd number of not()s inside the
 * frame; and the host bit of a sign (hostBit()) when a group searched above
 * it, below not()s of the same sign (an even number between them), covers
 * its search (see Index.covers) and so collects every term it does. A group
 * collected there needs no search of its own: it would find nothing the
 * searched one does not.
 */
const IN_TERMS = 16;
const FRAME_OR = 8;
const NEGATED = 4;

/** The host bit of a place's sign: 1 below an even number of not()s, 2 below an odd one. */
const hostBit = (cover: number): number => (cover & NEGATED ? 2 : 1);

/** Whether a group is collected where it sits, its conditions with it. */
const collectedAt = (
  group: GroupDescription,
  cover: number,
  jsonNull = !!jsonNullTested(group),
): boolean =>
  cover !== 0 &&
  (group.operator === "OR") ===
    (((cover & FRAME_OR) !== 0) !== ((cover & NEGATED) !== 0)) &&
  !jsonNull;

/** Where the condition below a not() at `cover` sits. */
const belowNot = (cover: number, predicate: PredicateDescription): number => {
  if (cover === 0) {
    return 0;
  }

  // Below two not()s, a condition is collected as written.
  if (cover & NEGATED) {
    return cover & ~NEGATED;
  }

  const inner = written(predicate);

  return inner.kind === "group" && collectedAt(inner, cover | NEGATED)
    ? cover | NEGATED
    : 0;
};

/**
 * Which answer of a part helps the whole condition hold for every row, the
 * only answer truth() asks for: TRUE below an even number of not()s, FALSE
 * below an odd one; any below an `IS NOT TRUE` (which reads NULL as FALSE
 * too) and where every answer counts (never()). Through AND, OR and NOT,
 * the FALSE of a part below an even number of not()s (the TRUE of one below
 * an odd number) never makes the whole TRUE where an unknown would not: so
 * the search of such an AND (such an OR), which can only find it FALSE
 * (TRUE), is not needed.
 */
const ANY_SENSE = 0;
const TRUE_HELPS = 1;
const FALSE_HELPS = 2;

/**
 * A column compared with a parameter that is never NULL (`id = $1`, `age <
 * $2`): unknown for every value it binds, except where the cases tried take
 * the column to be NULL. Its pairs and ranges are the searches' to find.
 */
const unbound = (description: Comparison): boolean =>
  description.right.kind === "placeholder" &&
  !description.right.nullable &&
  !description.nullableParameter &&
  description.left.kind === "column" &&
  INERT_OPERATORS.has(description.operator);

/** One case of a condition: TRUE, FALSE, NULL or unknown for every row. */
const evaluate = (
  description: PredicateDescription,
  analysis: Analysis,
  nested = false,
  cover = 0,
  sense = ANY_SENSE,
): Truth => {
  switch (description.kind) {
    case "group": {
      const { operator } = description;
      // is(null) of a NOT NULL jsonb column is one condition.
      const jsonNull = !!jsonNullTested(description);
      const collected = collectedAt(description, cover, jsonNull);
      // A group directly inside one of the same operator is not searched on
      // its own: its terms are among that one's (`nested`), also where that
      // one is not searched or does not cover it (see Index.covers). Nor is
      // one collected where a group searched above covers it (its host bit),
      // or one whose answer, if the search finds it, would not help the
      // condition hold for every row (see ANY_SENSE).
      const searched =
        !nested &&
        !(collected && cover & hostBit(cover)) &&
        (sense === ANY_SENSE ||
          (operator === "OR") === (sense === TRUE_HELPS)) &&
        !jsonNull;
      const frame = collected
        ? cover
        : IN_TERMS | (operator === "OR" ? FRAME_OR : 0);
      const inner =
        searched && indexOf(description).covers
          ? frame | hostBit(frame)
          : frame;
      let value: Truth;

      if (analysis.residuals && !analysis.assumed) {
        const slot = (inner & (IN_TERMS - 1)) + IN_TERMS * sense;
        const residual = analysis.residuals.get(description)?.[slot];

        if (residual) {
          // The children no bound value changes answer as at the first
          // analysis. Each of the others is read, even once the answer is
          // known, as a prepared write learns from the reads which values
          // the group consults.
          value = residual.fixed;

          for (const child of residual.live) {
            value = combined(
              operator,
              value,
              evaluate(
                child,
                analysis,
                !!merged(child, operator),
                inner,
                sense,
              ),
            );
          }
        } else {
          const split = residualOf(description, analysis, inner, sense);
          let entry = analysis.residuals.get(description);

          if (!entry) {
            entry = [];
            analysis.residuals.set(description, entry);
          }

          entry[slot] = split.residual;
          value = split.value;
        }
      } else {
        value = operator === "AND";

        for (const child of description.predicates) {
          value = combined(
            operator,
            value,
            evaluate(child, analysis, !!merged(child, operator), inner, sense),
          );
        }
      }

      // P OR NOT P holds for every row and P AND NOT P for none, when P is
      // never NULL.
      return value === undefined && searched && opposed(description, analysis)
        ? operator === "OR"
        : value;
    }
    case "not":
      return negated(
        evaluate(
          description.predicate,
          analysis,
          false,
          belowNot(cover, description.predicate),
          sense === ANY_SENSE
            ? ANY_SENSE
            : sense === TRUE_HELPS
              ? FALSE_HELPS
              : TRUE_HELPS,
        ),
      );
    case "notTrue": {
      const value = evaluate(description.predicate, analysis);

      return value === undefined ? undefined : value !== true;
    }
    case "membership": {
      if (!Array.isArray(description.values)) {
        // `x IN (no rows)` is FALSE even for a NULL x, `NOT IN` TRUE.
        return empty(description.values as SelectPlan, analysis)
          ? description.negated
          : undefined;
      }

      // In a $scope(), an emptied list is the condition it asks for.
      if (!description.values.length) {
        return analysis.scope ? undefined : description.negated;
      }

      const value = known(description.value, analysis);
      const found = anyOf(
        description.values.map((node: ValueNode) =>
          compared(value, "=", known(node, analysis)),
        ),
      );

      return description.negated ? negated(found) : found;
    }
    case "exists":
      return empty(description.query, analysis)
        ? description.negated
        : single(description.query, analysis)
          ? !description.negated
          : undefined;
    case "comparison": {
      const condition = written(description);

      if (condition !== description) {
        return evaluate(condition, analysis, nested, cover, sense);
      }

      // Outside the cases tried, a column compared with a parameter that is
      // never NULL depends on the data whatever it binds: one that a group's
      // search needs consults it there.
      if (
        analysis.inert?.has(description) ||
        (!analysis.assumed && unbound(description))
      ) {
        return undefined;
      }

      const nulled = boundToNull(description, analysis);

      if (nulled) {
        return evaluate(nulled, analysis);
      }

      const { operator } = description;
      const right = known(description.right, analysis);

      // An empty list asks for nothing, as notIn([]) does: every value
      // contains it and none overlaps it. In a write, contains() of one is
      // no condition (TRUE, even on a nullable column) and overlaps() FALSE;
      // in a $scope(), both are the condition they ask for.
      if (
        (operator === "@>" || operator === "&&") &&
        emptyOperand(description.left, right)
      ) {
        return analysis.scope ? undefined : operator === "@>";
      }

      // A pattern of only `%` matches every text. In a write an emptied
      // prefix counts as no condition, even on a nullable column (the
      // refusal says it matches every row that holds a text); in a $scope(),
      // it holds for every row only where the text is never NULL.
      if (
        (operator === "LIKE" || operator === "ILIKE") &&
        matchesEveryText(right)
      ) {
        const text = known(description.left, analysis);

        return !analysis.scope
          ? true
          : !text
            ? undefined
            : "value" in text && text.value === null
              ? null
              : true;
      }

      // Against a value not known, a comparison depends on the data.
      return (
        right && compared(known(description.left, analysis), operator, right)
      );
    }
    case "nullCheck": {
      const value = known(description.value, analysis);

      return !value
        ? undefined
        : "value" in value
          ? (value.value === null) !== description.negated
          : description.negated;
    }
    case "between": {
      const value = known(description.value, analysis);
      const lower = known(description.lower, analysis);
      const upper = known(description.upper, analysis);

      // From a bound above the other, BETWEEN holds for no number.
      if (
        lower &&
        upper &&
        "value" in lower &&
        "value" in upper &&
        orderedNumber(sqlTypeOf(description.value))
      ) {
        const from = exactNumber(lower.value);
        const to = exactNumber(upper.value);

        if (from !== undefined && to !== undefined && from > to) {
          return value && "value" in value && value.value === null
            ? null
            : definite(description.value, analysis)
              ? false
              : undefined;
        }
      }

      return allOf([
        compared(value, ">=", lower),
        compared(value, "<=", upper),
      ]);
    }
    default:
      return undefined;
  }
};

/**
 * A condition whatever the data. When that depends on whether values it
 * tests for NULL are NULL, each case is tried: `or(x.is(null), x.above(0),
 * x.atMost(0))` holds in both.
 */
const analyse = (
  description: PredicateDescription,
  analysis: Analysis,
  // What the caller asks: TRUE for every row, or no row (FALSE or NULL).
  goal: boolean,
): Truth => {
  // An AND holds for every row only where each of its terms does: a term
  // with its opposite makes it FALSE, which answers the same, so the
  // outermost AND is not searched for them (TRUE_HELPS alone skips it too).
  const current = goal ? written(description) : description;
  const whole = goal && current.kind === "group" && current.operator === "AND";
  // Only a search that can make the condition TRUE is needed.
  const sense = goal ? TRUE_HELPS : ANY_SENSE;
  const value = evaluate(current, analysis, whole, 0, sense);

  if (value !== undefined || analysis.assumed) {
    return value;
  }

  const values = nullTested(current, analysis);

  if (!values.length) {
    return undefined;
  }

  const outcomes = new Set<Truth>();

  for (let mask = 0; mask < 1 << values.length; mask += 1) {
    const outcome = evaluate(
      current,
      {
        ...analysis,
        assumed: values.map((node, position) => [
          node,
          (mask & (1 << position)) !== 0,
        ]),
      },
      whole,
      0,
      sense,
    );

    // A case that already answers otherwise ends the search.
    if (outcome === undefined || (goal ? outcome !== true : outcome === true)) {
      return undefined;
    }

    outcomes.add(outcome);
  }

  // Every row is one of the cases; FALSE and NULL alike pass no row.
  return outcomes.size === 1
    ? [...outcomes][0]
    : outcomes.size === 2 && outcomes.has(false) && outcomes.has(null)
      ? null
      : undefined;
};

/** How a condition is analysed besides the written table. */
type TruthOptions = {
  /** The values of one execution of a prepared write; unknown without it. */
  readonly bound?: BoundValue;
  /** A `$scope()` filter, where an emptied list is a condition. */
  readonly scope?: true;
  /** Comparisons whose bound values decide nothing, from `inertLeaves()`. */
  readonly inert?: ReadonlySet<PredicateDescription>;
  /** Where a prepared write keeps the parts of its filter no value changes. */
  readonly residuals?: Residuals;
};

/**
 * What a condition answers whatever the data, for the rows of the written
 * table `root`. These hold for every row:
 *
 * - a list that filtered down to nothing (`[userId && …]` without a user),
 *   `and()`, `not(or())`;
 * - `notIn([])`, `not(overlaps([]))`, `contains()` of an empty array or
 *   object and `like()` of only `%` (in a write, also on a nullable column),
 *   `notIn()` or `notExists()` of a query that finds nothing (an emptied
 *   `in([])`, `limit: 0`), a relation quantifier over such a condition
 *   (`every(() => [skipped])`, `none((post) => post.id.in([]))`), an
 *   aggregate of such a relation (`count().is(0)`);
 * - `exists()` of an aggregate without grouping, a count or a `length()`
 *   compared with what every count passes (`count().atLeast(0)`),
 *   `isNot(null)` of a NOT NULL column or of a `coalesce()` with a value that
 *   is never NULL, `not(between(5, 1))` of a NOT NULL number column;
 * - a condition together with its opposite where neither can be NULL
 *   (`or(id.notIn([2]), id.is(2))`, `or(flag.is(true), flag.is(false))` and
 *   `or(name.atLeast("m"), name.below("m"))` of NOT NULL columns, a column
 *   compared with another both ways, `or(posts.some(), posts.none())`,
 *   `exists()` beside `notExists()` of the same query, a condition beside its
 *   own not()), and pairs that hold where the value is NULL too
 *   (`or(x.is(null), x.isNot(null))`, `or(x.isDistinctFrom(2), x.is(2))`);
 * - comparisons of one NOT NULL number column with numbers that together
 *   cover every value (`or(id.atLeast(5), id.below(6))`,
 *   `or(id.below(5), id.is(5), id.above(5))`, `or(id.isNot(5), id.atLeast(5))`,
 *   between() as a piece, groups below a not() read by De Morgan), also of a
 *   nullable one beside its NULL check (`or(x.is(null), x.above(0),
 *   x.atMost(0))`, by trying both cases);
 * - any of these alone in a `sql<boolean>` template, in parentheses or with
 *   `= true` / `IS TRUE`.
 *
 * In a `$scope()` (`options.scope`), an emptied list is a condition. Only
 * TRUE is certain: a condition that holds for no row may read as unknown,
 * and the search is no proof.
 */
export const truth = (
  description: PredicateDescription,
  root: TableBinding,
  options?: TruthOptions,
): Truth =>
  analyse(
    description,
    options
      ? {
          roots: [root],
          ...(options.bound
            ? { bound: options.bound, oppositions: new Map() }
            : {}),
          ...(options.scope ? { scope: true as const } : {}),
          ...(options.inert?.size ? { inert: options.inert } : {}),
          ...(options.residuals ? { residuals: options.residuals } : {}),
        }
      : { roots: [root] },
    true,
  );

/**
 * Operators whose comparison of a column with a value that is never NULL
 * holds for some rows and not others, whatever the value (unlike LIKE with
 * `%`, or `@>` with an empty list).
 */
const INERT_OPERATORS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/**
 * The comparisons of a filter whose prepared values decide nothing about
 * whether it holds for every row: a column compared with a parameter that is
 * never NULL (`id = $1`, `age < $2`), whose column no other part of the
 * filter compares or tests for NULL. Such a comparison depends on the data
 * whatever it binds, and has no opposite or range to meet in the filter, so
 * a prepared write needs no check at each execution for it.
 */
const inertLeaves = (
  filter: PredicateDescription,
): ReadonlySet<PredicateDescription> => {
  const leaves: PredicateDescription[] = [];
  const operands = new Map<string, number>();
  const mention = (node: ValueNode) => {
    // NULLIF(column, 'null'::jsonb) compares the column too.
    const key = operandKey(jsonNullInner(node) ?? node);

    if (key !== undefined) {
      operands.set(key, (operands.get(key) ?? 0) + 1);
    }
  };
  const visit = (description: PredicateDescription): void => {
    const current = written(description);

    switch (current.kind) {
      case "group": {
        const value = jsonNullTested(current);

        if (value) {
          mention(value);
        } else {
          current.predicates.forEach(visit);
        }
        break;
      }
      case "not":
      case "notTrue":
        visit(current.predicate);
        break;
      case "comparison":
        leaves.push(current);
        mention(current.left);
        break;
      case "nullCheck":
        mention(current.value);
        break;
      case "membership":
      case "between":
        mention(current.value);
        break;
      default:
        break;
    }
  };

  visit(filter);

  return new Set(
    leaves.filter(
      (leaf) =>
        leaf.kind === "comparison" &&
        INERT_OPERATORS.has(leaf.operator) &&
        !leaf.nullableParameter &&
        leaf.left.kind === "column" &&
        leaf.right.kind === "placeholder" &&
        !leaf.right.nullable &&
        operands.get(operandKey(leaf.left)!) === 1,
    ),
  );
};

/**
 * The answers a condition may give at some values of a prepared write (see
 * mayHold()), as bits: TRUE, FALSE, NULL and unknown.
 */
const MAY_TRUE = 1;
const MAY_FALSE = 2;
const MAY_NULL = 4;
const MAY_UNKNOWN = 8;
const TRUTHS: readonly Truth[] = [true, false, null, undefined];

const truthBit = (value: Truth): number =>
  value === true
    ? MAY_TRUE
    : value === false
      ? MAY_FALSE
      : value === null
        ? MAY_NULL
        : MAY_UNKNOWN;

/** combined() of the answers two sides may give, by operator, for every pair of bits. */
const combinedAnswers = new Map<GroupDescription["operator"], Uint8Array>();

const combinedMay = (
  operator: GroupDescription["operator"],
  first: number,
  second: number,
): number => {
  let table = combinedAnswers.get(operator);

  if (!table) {
    table = new Uint8Array(256);

    for (let left = 0; left < 16; left += 1) {
      for (let right = 0; right < 16; right += 1) {
        let bits = 0;

        for (const one of TRUTHS) {
          for (const other of TRUTHS) {
            if (left & truthBit(one) && right & truthBit(other)) {
              bits |= truthBit(combined(operator, one, other));
            }
          }
        }

        table[left * 16 + right] = bits;
      }
    }

    combinedAnswers.set(operator, table);
  }

  return table[first * 16 + second]!;
};

const negatedMay = (bits: number): number =>
  (bits & MAY_TRUE ? MAY_FALSE : 0) |
  (bits & MAY_FALSE ? MAY_TRUE : 0) |
  (bits & (MAY_NULL | MAY_UNKNOWN));

/** A value that is not NULL, which one not known: what a parameter binds. */
const SOME_VALUE = Symbol("some value");

/** What known() may find for a node at some values; undefined for unknown. */
type Possible = readonly (Known | undefined)[];

const EVERY_KNOWN: Possible = [
  { value: null },
  { value: SOME_VALUE },
  { present: true },
  { count: true },
  undefined,
];

/**
 * The cases analyse() tries that mayHold() reads: the condition as it is,
 * and with every value it may test for NULL taken to be present, or NULL.
 */
type Case = 0 | 1 | 2;
const AS_IT_IS = 0;
const ALL_PRESENT = 1;
const ALL_NULL = 2;

/** One analysis of mayHold(): of the filter, or of a subquery's condition. */
type Level = {
  readonly roots: readonly TableBinding[];
  readonly inert?: ReadonlySet<PredicateDescription>;
  /**
   * The values its condition may test for NULL: by operand key (see
   * operandKey(), which sameValue() values share), and those without one.
   */
  readonly keys: ReadonlySet<string>;
  readonly others: readonly ValueNode[];
  /** Answers found, by condition and place. */
  readonly answers: Map<PredicateDescription, Map<number, number>>;
  readonly empties: Map<SelectPlan, boolean>;
};

/** The values a condition may test for NULL at some values (see nullTested()). */
const levelOf = (
  roots: readonly TableBinding[],
  description: PredicateDescription,
  inert?: ReadonlySet<PredicateDescription>,
): Level => {
  const keys = new Set<string>();
  const others: ValueNode[] = [];
  const seen = new Set<PredicateDescription>();
  const add = (value: ValueNode) => {
    if (value.kind === "parameter" || value.kind === "placeholder") {
      return;
    }

    const key = operandKey(value);

    if (key === undefined) {
      others.push(value);
    } else {
      keys.add(key);
    }
  };
  const visit = (current: PredicateDescription): void => {
    if (seen.has(current)) {
      return;
    }

    seen.add(current);

    switch (current.kind) {
      case "group":
        current.predicates.forEach(visit);
        break;
      case "not":
      case "notTrue":
        visit(current.predicate);
        break;
      case "comparison": {
        const condition = written(current);

        if (condition !== current) {
          visit(condition);
          break;
        }

        if (current.nullableParameter && current.right.kind === "placeholder") {
          visit(current.nullCheck ?? nullCheckOf(current.left));
        }

        if (
          current.operator === "IS DISTINCT FROM" ||
          current.operator === "IS NOT DISTINCT FROM"
        ) {
          add(current.left);
        }
        break;
      }
      case "nullCheck":
        add(current.value);
        break;
      default:
        break;
    }
  };

  visit(description);

  return {
    roots,
    ...(inert?.size ? { inert } : {}),
    keys,
    others,
    answers: new Map(),
    empties: new Map(),
  };
};

/** known() of a node at some values, in one case of a level. */
const possibly = (node: ValueNode, level: Level, at: Case): Possible => {
  const found = possibleBase(node, level, at);
  let tested = false;

  if (at !== AS_IT_IS && (level.keys.size || level.others.length)) {
    const key = operandKey(node);

    tested =
      key === undefined
        ? level.others.some((value) => sameValue(value, node))
        : level.keys.has(key);
  }

  return tested
    ? [...found, at === ALL_PRESENT ? { present: true } : { value: null }]
    : found;
};

/** possibly() of a node that is not taken to be present or NULL. */
const possibleBase = (node: ValueNode, level: Level, at: Case): Possible => {
  switch (node.kind) {
    case "parameter":
      return [{ value: node.value }];
    case "placeholder":
      // Bound to null, a JSON parameter that may not be null binds JSON null.
      return node.nullable ||
        node.sqlType === "jsonb" ||
        node.sqlType === "json"
        ? [{ value: SOME_VALUE }, { value: null }, undefined]
        : [{ value: SOME_VALUE }, undefined];
    case "column":
      return [known(node, { roots: level.roots })];
    case "arrayLength":
      return node.json
        ? [undefined]
        : possibly(node.value, level, at).map((value) =>
            !value
              ? undefined
              : "value" in value && value.value === null
                ? { value: null }
                : { count: true },
          );
    case "rowCount":
      return mayBeEmpty(node.query, level)
        ? [{ value: 0 }, { count: true }]
        : [{ count: true }];
    case "raw": {
      const json = jsonNullInner(node);

      if (json) {
        return possibly(json, level, at).flatMap((value) =>
          !value || !("value" in value)
            ? [undefined]
            : value.value === SOME_VALUE
              ? [value, { value: null }]
              : isJsonNullText(value.value)
                ? [{ value: null }]
                : [value],
        );
      }

      const cast = castInner(node, "text");

      if (cast) {
        return possibly(cast, level, at).map((value) =>
          !value
            ? undefined
            : "value" in value && value.value === null
              ? { value: null }
              : { present: true },
        );
      }

      const [text, subquery] = node.parts;

      if (
        !node.composed ||
        node.parts.length !== 2 ||
        text !== "EXISTS " ||
        typeof subquery !== "object" ||
        subquery.kind !== "subquery"
      ) {
        return [undefined];
      }

      return [
        ...(mayBeEmpty(subquery.query, level) ? [{ value: false }] : []),
        ...(maySingle(subquery.query) ? [{ value: true }] : []),
        undefined,
      ];
    }
    case "subquery":
    case "coalesce":
      return EVERY_KNOWN;
    default:
      return [undefined];
  }
};

/** compared() of every pair of what two sides may be. */
const comparedMay = (
  left: Possible,
  operator: string,
  right: Possible,
): number => {
  let bits = 0;

  for (const first of left) {
    for (const second of right) {
      if (!first || !second) {
        bits |= MAY_UNKNOWN;
        continue;
      }

      const some =
        "value" in first && first.value === SOME_VALUE
          ? second
          : "value" in second && second.value === SOME_VALUE
            ? first
            : undefined;

      // A value that is not NULL against NULL is as any such value is;
      // against a present value of no count it is unknown; else any.
      bits |= !some
        ? truthBit(compared(first, operator, second))
        : "value" in some && some.value === null
          ? truthBit(compared({ value: 0 }, operator, some))
          : "present" in some
            ? MAY_UNKNOWN
            : MAY_TRUE | MAY_FALSE | MAY_UNKNOWN;
    }
  }

  return bits;
};

/** A subquery that may return no row at some values (see empty()). */
const mayBeEmpty = (query: SelectPlan, level: Level): boolean => {
  let found = level.empties.get(query);

  if (found === undefined) {
    const { roots } = inside(query, { roots: level.roots });

    found =
      (query.limit !== undefined &&
        (typeof query.limit !== "number" || query.limit === 0)) ||
      query.having.some((description) => mayBeNever(description, roots)) ||
      (!collapsed(query) &&
        query.predicates.some((description) => mayBeNever(description, roots)));
    level.empties.set(query, found);
  }

  return found;
};

/** A subquery that may return exactly one row at some values (see single()). */
const maySingle = (query: SelectPlan): boolean =>
  collapsed(query) &&
  !query.having.length &&
  (typeof query.limit !== "number" || query.limit > 0) &&
  (typeof query.offset !== "number" || query.offset === 0);

/** A condition of a subquery that may pass no row at some values (see never()). */
const mayBeNever = (
  description: PredicateDescription,
  roots: readonly TableBinding[],
): boolean => {
  const level = levelOf(roots, description);
  const none = MAY_FALSE | MAY_NULL;

  return (
    (mayAnswer(description, level, AS_IT_IS) & none) !== 0 ||
    ((level.keys.size > 0 || level.others.length > 0) &&
      (mayAnswer(description, level, ALL_PRESENT) & none) !== 0 &&
      (mayAnswer(description, level, ALL_NULL) & none) !== 0)
  );
};

/** A group whose search may find a pair or a range at some values (see oppositionOf()). */
const mayOppose = (group: GroupDescription): boolean => {
  const index = indexOf(group);

  return (
    index.changes ||
    index.fixed.pairs.length > 0 ||
    index.fixed.ranges.length > 0 ||
    !!index.fixed.certain ||
    !!replayOf(group, index)
  );
};

/**
 * The answers evaluate() may give for a condition at some values of a
 * prepared write, in one case of a level: each value as it may be (a
 * parameter any value, NULL too where it may be NULL), and each group
 * searched where evaluate() searches it, finding a pair or a range wherever
 * mayOppose() says it may.
 */
const mayAnswer = (
  description: PredicateDescription,
  level: Level,
  at: Case,
  nested = false,
  cover = 0,
  sense = ANY_SENSE,
): number => {
  const place = (((at * 3 + sense) * 32 + cover) << 1) | (nested ? 1 : 0);
  let entry = level.answers.get(description);
  let bits = entry?.get(place);

  if (bits === undefined) {
    bits = newAnswer(description, level, at, nested, cover, sense);

    if (!entry) {
      entry = new Map();
      level.answers.set(description, entry);
    }

    entry.set(place, bits);
  }

  return bits;
};

/** mayAnswer() not found before. */
const newAnswer = (
  description: PredicateDescription,
  level: Level,
  at: Case,
  nested: boolean,
  cover: number,
  sense: number,
): number => {
  switch (description.kind) {
    case "group": {
      const { operator } = description;
      const jsonNull = !!jsonNullTested(description);
      const collected = collectedAt(description, cover, jsonNull);
      const searched =
        !nested &&
        !(collected && cover & hostBit(cover)) &&
        (sense === ANY_SENSE ||
          (operator === "OR") === (sense === TRUE_HELPS)) &&
        !jsonNull;
      const frame = collected
        ? cover
        : IN_TERMS | (operator === "OR" ? FRAME_OR : 0);
      const inner =
        searched && indexOf(description).covers
          ? frame | hostBit(frame)
          : frame;
      let bits = truthBit(operator === "AND");

      for (const child of description.predicates) {
        bits = combinedMay(
          operator,
          bits,
          mayAnswer(child, level, at, !!merged(child, operator), inner, sense),
        );
      }

      return bits & MAY_UNKNOWN && searched && mayOppose(description)
        ? bits | (operator === "OR" ? MAY_TRUE : MAY_FALSE)
        : bits;
    }
    case "not":
      return negatedMay(
        mayAnswer(
          description.predicate,
          level,
          at,
          false,
          belowNot(cover, description.predicate),
          sense === ANY_SENSE
            ? ANY_SENSE
            : sense === TRUE_HELPS
              ? FALSE_HELPS
              : TRUE_HELPS,
        ),
      );
    case "notTrue": {
      const inner = mayAnswer(description.predicate, level, at);

      return (
        (inner & MAY_UNKNOWN) |
        (inner & MAY_TRUE ? MAY_FALSE : 0) |
        (inner & (MAY_FALSE | MAY_NULL) ? MAY_TRUE : 0)
      );
    }
    case "membership": {
      if (!Array.isArray(description.values)) {
        return (
          (mayBeEmpty(description.values as SelectPlan, level)
            ? truthBit(description.negated)
            : 0) | MAY_UNKNOWN
        );
      }

      if (!description.values.length) {
        return truthBit(description.negated);
      }

      const value = possibly(description.value, level, at);
      let found = MAY_FALSE;

      for (const node of description.values as readonly ValueNode[]) {
        found = combinedMay(
          "OR",
          found,
          comparedMay(value, "=", possibly(node, level, at)),
        );
      }

      return description.negated ? negatedMay(found) : found;
    }
    case "exists":
      return (
        (mayBeEmpty(description.query, level)
          ? truthBit(description.negated)
          : 0) |
        (maySingle(description.query) ? truthBit(!description.negated) : 0) |
        MAY_UNKNOWN
      );
    case "comparison": {
      const condition = written(description);

      if (condition !== description) {
        return mayAnswer(condition, level, at, nested, cover, sense);
      }

      if (
        level.inert?.has(description) ||
        (at === AS_IT_IS && unbound(description))
      ) {
        return MAY_UNKNOWN;
      }

      let bits = 0;
      let right = possibly(description.right, level, at);

      // Bound to null, it is the null check (see boundToNull()).
      if (
        description.nullableParameter &&
        description.right.kind === "placeholder"
      ) {
        const check = description.nullCheck ?? nullCheckOf(description.left);

        bits |= mayAnswer(
          description.operator === "<>"
            ? { kind: "not", predicate: check }
            : check,
          level,
          at,
        );
        right = right.filter(
          (value) => !value || !("value" in value) || value.value !== null,
        );
      }

      const { operator } = description;
      const values = right.filter((value): value is Known => !!value);

      if (values.length < right.length) {
        bits |= MAY_UNKNOWN;
      }

      if (
        (operator === "@>" || operator === "&&") &&
        values.some((value) =>
          "value" in value && value.value === SOME_VALUE
            ? sqlTypeOf(description.left).endsWith("[]") ||
              isJson(description.left)
            : emptyOperand(description.left, value),
        )
      ) {
        bits |= truthBit(operator === "@>");
      }

      if (
        (operator === "LIKE" || operator === "ILIKE") &&
        values.some(
          (value) =>
            ("value" in value && value.value === SOME_VALUE) ||
            matchesEveryText(value),
        )
      ) {
        bits |= MAY_TRUE;
      }

      return (
        bits |
        comparedMay(possibly(description.left, level, at), operator, values)
      );
    }
    case "nullCheck": {
      let bits = 0;

      for (const value of possibly(description.value, level, at)) {
        bits |= !value
          ? MAY_UNKNOWN
          : "value" in value && value.value !== SOME_VALUE
            ? truthBit((value.value === null) !== description.negated)
            : truthBit(description.negated);
      }

      return bits;
    }
    case "between": {
      const value = possibly(description.value, level, at);
      const lower = possibly(description.lower, level, at);
      const upper = possibly(description.upper, level, at);
      let bits = combinedMay(
        "AND",
        comparedMay(value, ">=", lower),
        comparedMay(value, "<=", upper),
      );

      // From a bound above the other, NULL, FALSE or unknown.
      if (orderedNumber(sqlTypeOf(description.value))) {
        for (const from of lower) {
          for (const to of upper) {
            if (from && to && "value" in from && "value" in to) {
              const low =
                from.value === SOME_VALUE ? undefined : exactNumber(from.value);
              const high =
                to.value === SOME_VALUE ? undefined : exactNumber(to.value);

              if (
                from.value === SOME_VALUE ||
                to.value === SOME_VALUE ||
                (low !== undefined && high !== undefined && low > high)
              ) {
                bits |= MAY_NULL | MAY_FALSE | MAY_UNKNOWN;
              }
            }
          }
        }
      }

      return bits;
    }
    default:
      return MAY_UNKNOWN;
  }
};

/**
 * Whether some values of a prepared write may make its filter hold for
 * every row: truth() with those values answers TRUE only where evaluate()
 * does as the filter is, or in every case analyse() tries, among them the
 * one where the values it tests for NULL are present and the one where they
 * are NULL. A filter where none of these can be TRUE at any values
 * (`or(id.is(a), age.is(b))`, `posts.some((post) => post.views.isNot(b))`
 * with `b` nullable) needs no check at its executions.
 */
const mayHold = (
  filter: PredicateDescription,
  root: TableBinding,
  inert: ReadonlySet<PredicateDescription>,
): boolean => {
  const current = written(filter);
  const whole = current.kind === "group" && current.operator === "AND";
  const level = levelOf([root], current, inert);
  const holds = (at: Case) =>
    (mayAnswer(current, level, at, whole, 0, TRUE_HELPS) & MAY_TRUE) !== 0;

  return (
    holds(AS_IT_IS) ||
    ((level.keys.size > 0 || level.others.length > 0) &&
      holds(ALL_PRESENT) &&
      holds(ALL_NULL))
  );
};

/**
 * PostgreSQL's "ON CONFLICT DO UPDATE command cannot affect row a second
 * time". Its SQLSTATE 21000 also reports a subquery that returned more than
 * one row; the routine that raised it (or, without one, the untranslated
 * command name in the message) tells them apart.
 */
const conflictedTwice = (error: unknown): boolean => {
  if (sqlState(error) !== "21000") {
    return false;
  }

  const { routine, message } = error as {
    routine?: unknown;
    message?: unknown;
  };

  return typeof routine === "string"
    ? routine === "ExecOnConflictUpdate" || routine === "ExecOnConflictLockRow"
    : typeof message === "string" && message.includes("ON CONFLICT DO UPDATE");
};

/** Refusals of a filter that holds for every row; a later where() that adds a condition lifts them. */
const everyRowErrors = new WeakSet<object>();

/**
 * What made a filter hold for every row that holds a value: contains() of an
 * empty list or object, or like() of a pattern of only `%`.
 */
type Emptied = "contains" | "like";

/**
 * The refusal of a filter that holds for every row. One that holds because
 * contains() was given an empty list or object, or like() a pattern of only
 * `%`, says so: it is not every row of the table, but every row that holds a
 * value.
 */
const everyRowRefusal = (
  kind: MutationPlan["kind"],
  emptied?: Emptied,
): Error =>
  new Error(
    emptied === "contains"
      ? `symmetria: ${kind}() where() leaves no condition: contains() of an empty list or object matches every row that holds a value, as notIn([]) matches every row; use isNot(null) for the rows that hold one, or call .all() to ${kind} every row`
      : emptied === "like"
        ? `symmetria: ${kind}() where() leaves no condition: like() or ilike() of a pattern of only % (an empty prefix) matches every row that holds a text, as notIn([]) matches every row; use isNot(null) for the rows that hold one, or call .all() to ${kind} every row`
        : `symmetria: ${kind}() where() leaves no condition (an empty list, and() or notIn([]) holds for every row); call .all() to ${kind} every row`,
  );

/**
 * Whether a condition has a contains() of an empty list or object, or a
 * like() of only `%`, in its subqueries too.
 */
const emptiedBy = (
  description: PredicateDescription,
  root: TableBinding,
  bound?: BoundValue,
): Emptied | undefined => {
  const analysis: Analysis = { roots: [root], ...(bound ? { bound } : {}) };
  const first = (
    descriptions: readonly PredicateDescription[],
  ): Emptied | undefined => {
    for (const current of descriptions) {
      const found = visit(current);

      if (found) {
        return found;
      }
    }

    return undefined;
  };
  const visit = (current: PredicateDescription): Emptied | undefined => {
    switch (current.kind) {
      case "group":
        return first(current.predicates);
      case "not":
      case "notTrue":
        return visit(current.predicate);
      case "comparison": {
        const condition = written(current);

        if (condition !== current) {
          return visit(condition);
        }

        const right = known(current.right, analysis);

        return current.operator === "@>" && emptyOperand(current.left, right)
          ? "contains"
          : (current.operator === "LIKE" || current.operator === "ILIKE") &&
              matchesEveryText(right)
            ? "like"
            : undefined;
      }
      case "exists":
        return first([...current.query.predicates, ...current.query.having]);
      case "membership":
        return Array.isArray(current.values)
          ? undefined
          : first((current.values as SelectPlan).predicates);
      default:
        return undefined;
    }
  };

  return visit(description);
};

/**
 * The values of one execution of a prepared query, as it binds them: null
 * binds SQL null to a parameter that may be null and JSON null to a JSON one
 * that may not; other values are encoded as a literal of the same value
 * would be. A missing value, or one it refuses to bind, is unknown here;
 * binding fails the execution.
 */
const boundValues = (values: unknown): BoundValue | undefined => {
  if (!values || typeof values !== "object") {
    return undefined;
  }

  // The checks ask for one parameter several times: each is encoded once.
  const encoded = new Map<
    PlaceholderNode,
    { readonly value: unknown } | undefined
  >();
  const encode = (node: PlaceholderNode) => {
    const value = Object.hasOwn(values, node.name)
      ? (values as Record<string, unknown>)[node.name]
      : undefined;

    if (value === undefined) {
      return undefined;
    }

    try {
      return throwDataErrors(() =>
        value !== null
          ? { value: encodeValue(value, node.codec) }
          : node.nullable
            ? { value: null }
            : node.sqlType === "jsonb" || node.sqlType === "json"
              ? {
                  value: node.codec ? node.codec.encode(null as never) : "null",
                }
              : undefined,
      );
    } catch {
      return undefined;
    }
  };

  return (node) => {
    let found = encoded.get(node);

    if (found === undefined && !encoded.has(node)) {
      found = encode(node);
      encoded.set(node, found);
    }

    return found;
  };
};

/** A where() filter of a prepared write, checked again at each execution. */
type PreparedFilter = {
  readonly filter: PredicateDescription;
  readonly inert: ReadonlySet<PredicateDescription>;
  readonly residuals: Residuals;
};

/**
 * Comparisons of a column with a parameter that no value makes hold for
 * every row. A LIKE pattern can be `%`.
 */
const PINNED_OPERATORS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/**
 * A condition no bound value makes hold for every row: a column compared
 * with a parameter (`id = $1`), or an AND with such a part. `isNot(p)` of a
 * parameter that may be null is not one: bound to null it is `isNot(null)`.
 */
const pinned = (description: PredicateDescription): boolean =>
  description.kind === "group"
    ? description.operator === "AND" && description.predicates.some(pinned)
    : description.kind === "comparison" &&
      description.left.kind === "column" &&
      description.right.kind === "placeholder" &&
      PINNED_OPERATORS.has(description.operator) &&
      !(description.nullableParameter && description.operator === "<>");

export const createMutation = (
  kind: MutationPlan["kind"],
  root: TableBinding,
  input:
    | Record<string, unknown>
    | readonly Record<string, unknown>[]
    | ((row: RuntimeScope[string]) => Record<string, unknown>),
  executor?: QueryExecutor,
  options: MutationOptions = {},
): object => {
  const profile = executorProfiling(executor);
  const bindings = freeze({ [root.alias]: root });
  const scope = createScope(bindings);

  const columnNode = (column: ColumnSnapshot): ValueNode =>
    freeze({
      kind: "column",
      description: freeze({ binding: root, column }),
    });

  /**
   * Runs a callback of the write as a query runs its option callbacks: a
   * query built inside it over the written table gets a source occurrence of
   * its own, so a condition that correlates it with the written row
   * (`notExists(db.comments(…, { where: (reply) => reply.parentId.is(comment.id) }))`)
   * still compares two rows.
   */
  const ownOccurrences = <Result>(
    local: () => SelectPlan["bindings"],
    callback: () => Result,
  ): Result => {
    const previous = shapeFrame.bindings;
    shapeFrame.bindings = previous
      ? () => ({ ...previous(), ...local() })
      : local;

    try {
      return callback();
    } finally {
      shapeFrame.bindings = previous;
    }
  };

  /**
   * Predicates may follow relation paths; the resulting JOINs cannot live in an
   * UPDATE or DELETE, so they move into a primary-key subquery. `filter` is
   * the condition as written, which the every-row guard reads.
   */
  const wherePredicate = (
    callback: (row: RuntimeScope[string]) => Predicate | PredicateList,
  ): { description: PredicateDescription; filter: PredicateDescription } => {
    // An array combines with AND, like the where option of a query.
    const evaluate = (row: RuntimeScope[string]): Predicate => {
      const result = callback(row);

      return Array.isArray(result) ? and(...result) : (result as Predicate);
    };

    if (!options.context) {
      const description = readPredicate(
        ownOccurrences(
          () => bindings,
          () => evaluate(scope[root.alias]!),
        ),
      );

      return { description, filter: description };
    }

    const context = options.context(initialPlan(root));
    const description = readPredicate(
      ownOccurrences(
        () => context.plan.bindings,
        () => evaluate(context.scope()[root.alias]!),
      ),
    );

    if (!context.plan.joins.length) {
      return { description, filter: description };
    }

    const keys = primaryKeyColumns(root.table);

    if (!keys.length) {
      throw new Error(
        `symmetria: relation paths in ${kind}().where() require a primary key on "${root.alias}"`,
      );
    }

    const subquery: SelectPlan = freeze({
      ...context.plan,
      selection: freeze(
        keys.map((column) =>
          freeze({ outputName: column.name, node: columnNode(column) }),
        ),
      ),
      predicates: freeze([...context.plan.predicates, description]),
    });
    const value: ValueNode =
      keys.length === 1
        ? columnNode(keys[0]!)
        : freeze({
            kind: "tuple",
            values: freeze(keys.map(columnNode)),
          });

    writeKeySubqueries.add(subquery);

    return {
      description: freeze({
        kind: "membership",
        value,
        values: subquery,
        negated: false,
      }),
      filter: description,
    };
  };

  /** The where() filters moved into a primary-key subquery, by the predicate that carries them. */
  const movedFilters = new WeakMap<
    PredicateDescription,
    PredicateDescription
  >();

  /**
   * Whether the plan's filter has a condition that depends on the data: a
   * lookup's key or a where() that does not hold for every row. A $scope()
   * bounds the write but is no filter.
   */
  const conditioned = (plan: MutationPlan): boolean =>
    plan.predicates.some(
      (description) =>
        description.kind !== "scope" &&
        truth(movedFilters.get(description) ?? description, root) !== true,
    );

  // Captured by the initial immutable plan; conflict assignments are walked separately.
  let atomicValues = true;
  const columnsByName = new Map(
    root.table.columns.map((column) => [column.name, column]),
  );
  const requiredColumns = root.table.columns.filter(
    (column) => column.notNull && !column.default,
  );

  const readValues = (
    values: Record<string, unknown>,
    insert = false,
  ): Readonly<Record<string, ValueNode | typeof DEFAULT_VALUE>> => {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      dataError(new Error("symmetria: values must be an object"));

      return freeze(Object.create(null));
    }

    // undefined means omitted, as for query options; unknown keys still fail.
    const result: Record<string, ValueNode | typeof DEFAULT_VALUE> =
      Object.create(null);
    let assigned = 0;

    for (const name of Object.keys(values)) {
      const value = values[name];
      const column = columnsByName.get(name);

      if (!column) {
        throw new Error(`symmetria: unknown column "${root.alias}.${name}"`);
      }

      if (value === undefined) {
        continue;
      }

      // A non-nullable json/jsonb column stores null as the JSON value null.
      const jsonNull =
        value === null &&
        column.notNull &&
        (column.sqlType === "jsonb" || column.sqlType === "json");

      // Errors about the values themselves fail the write when it runs.
      if (value === null && column.notNull && !jsonNull) {
        dataError(
          new Error(`symmetria: "${root.alias}.${name}" cannot be null`),
        );
      }

      if (value === DEFAULT_VALUE && !column.default && column.notNull) {
        dataError(
          new Error(`symmetria: "${root.alias}.${name}" has no default`),
        );
      }

      if (
        column.default?.kind === "sql" &&
        column.default.sql === "identity" &&
        value !== DEFAULT_VALUE
      ) {
        dataError(
          new Error(
            `symmetria: "${root.alias}.${name}" is generated always; use defaultValue`,
          ),
        );
      }

      // A text column would store an object as its JSON text without a word.
      if (
        typeof value === "object" &&
        value !== null &&
        !root.codecs[name] &&
        !(COLUMN_EXPRESSION in value) &&
        /^(?:text|varchar|character varying|char|character|bpchar)\b/.test(
          column.sqlType,
        ) &&
        !column.sqlType.endsWith("[]")
      ) {
        dataError(
          new Error(
            `symmetria: "${root.alias}.${name}" is ${column.sqlType} and takes a string, received ${Array.isArray(value) ? "an array" : "an object"}`,
          ),
        );
      }

      const node =
        value === DEFAULT_VALUE
          ? DEFAULT_VALUE
          : jsonNull
            ? jsonNullValue(root.codecs[name], column.sqlType)
            : valueNode(value, root.codecs[name]);

      if (
        node !== DEFAULT_VALUE &&
        node.kind !== "parameter" &&
        node.kind !== "placeholder" &&
        node.kind !== "column"
      ) {
        atomicValues = false;
      }

      result[name] = node;
      assigned += 1;
    }

    if (insert) {
      for (const column of requiredColumns) {
        // Own keys only: a column named "constructor" is not Object's.
        if (
          !Object.hasOwn(values, column.name) ||
          values[column.name] === undefined
        ) {
          dataError(
            new Error(
              `symmetria: missing required column "${root.alias}.${column.name}"`,
            ),
          );
        }
      }
    }

    if (!insert && !assigned) {
      dataError(new Error("symmetria: update() requires at least one value"));
    }

    if (!insert) {
      // New text under an old embedding would be found by what it used to say.
      for (const { column, sources } of embeddingColumns.get(root.table) ??
        []) {
        if (
          result[column] === undefined &&
          sources.some((source) => result[source] !== undefined)
        ) {
          result[column] = valueNode(null, root.codecs[column]);
        }
      }
    }

    return freeze(result);
  };

  // A lookup's key and the $scope() restrict UPDATE and DELETE; the $scope()
  // predicates alone are checked against every row an INSERT or UPDATE writes.
  const restriction = options.scope?.() ?? [];
  const checks =
    kind !== "delete" && restriction.length
      ? restriction.filter((description) => description.kind === "scope")
      : [];

  const [initial, failure] = collectDataErrors((): MutationPlan => {
    const resolved =
      typeof input === "function"
        ? ownOccurrences(
            () => bindings,
            () =>
              input(
                columnsOnly(
                  root.table,
                  scope[root.alias]!,
                  `${kind === "insert" ? "insert" : "update"} values`,
                ),
              ),
          )
        : input;
    const rows = Array.isArray(resolved) ? resolved : [resolved];
    const single = kind === "insert" && !Array.isArray(resolved);

    if (kind === "update" && !rows.length) {
      dataError(new Error("symmetria: update() requires at least one value"));
    }

    const values = freeze(
      kind === "delete"
        ? []
        : rows.map((row) => readValues(row, kind === "insert")),
    );

    return freeze({
      kind,
      root,
      bindings,
      values,
      atomicValues,
      predicates: freeze(kind === "insert" ? [] : [...restriction]),
      selection: freeze([]),
      ...(checks.length ? { checks: freeze(checks) } : {}),
      ...(single ? { single: true as const } : {}),
    });
  });

  /** The next immutable state; data errors found while building it fail it when it runs. */
  const derive = (next: () => MutationPlan): MutationPlan => {
    const [plan, error] = collectDataErrors(next);

    return error && !plan.failure ? freeze({ ...plan, failure: error }) : plan;
  };

  const chunkPlans = new WeakMap<MutationPlan, readonly MutationPlan[]>();

  const executeChunked = async (
    state: MutationPlan,
    compile?: (plan: MutationPlan) => CompiledQuery,
  ) => {
    const limit = PARAMETER_LIMIT;
    const compiled = compile ?? compilePlan;
    let chunks = chunkPlans.get(state);

    const run = (plan: MutationPlan, execute: QueryExecutor | undefined) => {
      const result = compile
        ? executeCompiled(plan, compile(plan), execute)
        : executePlan(plan, execute);
      const upsert = plan.conflict?.action === "update" && plan.conflict;

      return plan.checks || upsert
        ? result.catch((error: unknown) => {
            // PostgreSQL found two rows with one key ("cannot affect row a
            // second time"): the documented refusal, whatever the spelling.
            if (upsert && conflictedTwice(error)) {
              throw duplicateKeyError(root, upsert.columns, error);
            }

            throw plan.checks ? scopeViolation(error) : error;
          })
        : result;
    };

    if (
      state.kind !== "insert" ||
      state.values.length < 2 ||
      !options.atomic ||
      !limit ||
      // Atomic values bind at most one parameter each, so most inserts are
      // provably under the limit without compiling; compilePlan caches otherwise.
      (state.atomicValues &&
        state.values.length * root.table.columns.length + 1000 <= limit)
    ) {
      return run(state, executor);
    }

    if (!chunks && compiled(state).parameters.length <= limit) {
      // Rows sent as one array per column fit one statement however many
      // they are. One with more values than the limit still runs in a
      // savepoint, as a split insert does, so a failure the caller catches
      // leaves the transaction usable whichever form the insert takes.
      return state.values.length * Object.keys(state.values[0]!).length > limit
        ? options.atomic((atomicExecutor) => run(state, atomicExecutor))
        : run(state, executor);
    }

    // Halve until every chunk fits; rows may bind different numbers of parameters.
    if (!chunks) {
      const plans: MutationPlan[] = [];

      const split = (values: MutationPlan["values"]): void => {
        const chunk: MutationPlan = freeze({ ...state, values });

        if (values.length > 1 && compiled(chunk).parameters.length > limit) {
          const middle = Math.ceil(values.length / 2);
          split(values.slice(0, middle));
          split(values.slice(middle));
        } else {
          plans.push(chunk);
        }
      };

      split(state.values);
      chunks = plans;
      chunkPlans.set(state, chunks);
    }

    const runChunks = async (atomicExecutor: QueryExecutor | undefined) => {
      const rows: Record<string, unknown>[] = [];
      let affectedRows = 0;

      // Split over several statements, a later row with an earlier row's key
      // would overwrite it without an error. Keys this code cannot compare
      // as their type does (inet, interval, jsonb …) are compared by
      // PostgreSQL first, in the same transaction.
      if (state.conflict?.action === "update") {
        const probe = duplicateKeyProbe(state.conflict.columns, state.values);
        const execute = atomicExecutor ?? executor;

        if (
          probe &&
          execute &&
          normalizeResult(await execute(probe)).rows.length
        ) {
          throw duplicateKeyError(root, state.conflict.columns);
        }
      }

      for (const chunk of chunks!) {
        const result = await run(chunk, atomicExecutor);
        rows.push(...result.rows);
        affectedRows += result.affectedRows;
      }

      return { rows, affectedRows };
    };

    return options.atomic(runChunks);
  };

  /**
   * The where() filters of a prepared UPDATE or DELETE whose parameters
   * decide whether they hold for every row; undefined when no value can make
   * the whole filter do so (a condition no parameter reaches, `.all()`).
   */
  const parameterFilters = (
    state: MutationPlan,
  ): readonly PreparedFilter[] | undefined => {
    if (state.kind === "insert" || state.unrestricted || state.failure) {
      return undefined;
    }

    let consulted = false;
    const unknown: BoundValue = () => {
      consulted = true;

      return undefined;
    };
    const filters: PreparedFilter[] = [];

    for (const description of state.predicates) {
      if (description.kind === "scope") {
        continue;
      }

      const filter = movedFilters.get(description) ?? description;

      // A lookup's key or `where: id = $1`: a condition whatever the values.
      if (pinned(filter)) {
        return undefined;
      }

      const inert = inertLeaves(filter);
      // Split at this first analysis, which no bound value takes part in.
      const residuals: Residuals = new Map();

      consulted = false;

      if (truth(filter, root, { bound: unknown, inert, residuals }) !== true) {
        // One that consults no value, or that no values can make hold for
        // every row, makes the whole filter hold for no values either.
        if (!consulted || !mayHold(filter, root, inert)) {
          return undefined;
        }

        filters.push({ filter, inert, residuals });
      }
    }

    return filters.length ? filters : undefined;
  };

  /**
   * A prepared write refuses, at each execution, values that make its filter
   * hold for every row (`isNot(p)` of a NOT NULL column bound to null,
   * `count().atLeast(p)` bound to 0), as the same filter written with those
   * values is refused.
   */
  const checkedPrepared = (
    state: MutationPlan,
    prepared: PreparedQuery<unknown, Record<string, unknown>, PreparedKind>,
  ) => {
    const filters = parameterFilters(state);

    if (!filters) {
      return prepared;
    }

    const run = prepared as unknown as (
      values?: Record<string, unknown>,
    ) => Promise<unknown>;
    const check = (values: unknown) => {
      const bound = boundValues(values);

      if (
        bound &&
        filters.every(
          ({ filter, inert, residuals }) =>
            truth(filter, root, { bound, inert, residuals }) === true,
        )
      ) {
        throw everyRowRefusal(
          state.kind,
          filters
            .map(({ filter }) => emptiedBy(filter, root, bound))
            .find((emptied) => emptied),
        );
      }
    };
    const execute = async (values?: Record<string, unknown>) => {
      check(values);

      return run(values);
    };

    return Object.freeze(
      Object.assign(execute, {
        execute,
        toSQL: (values?: Record<string, unknown>) => {
          check(values);

          return (
            prepared.toSQL as unknown as (
              values?: Record<string, unknown>,
            ) => CompiledQuery
          )(values);
        },
      }),
    );
  };

  const build = (state: MutationPlan): object => {
    const executeUsing = async (
      compile?: (plan: MutationPlan) => CompiledQuery,
    ) => {
      // `insert([])` is a no-op: nothing to write, nothing returned. Scope
      // checks run inside each statement, which fails as a whole.
      const result =
        state.kind === "insert" && !state.values.length
          ? { rows: [], affectedRows: 0 }
          : await executeChunked(state, compile);

      if (!state.selection.length) {
        return { affectedRows: result.affectedRows };
      }

      return state.single ? (result.rows[0] ?? null) : result.rows;
    };

    const execute = () => executeUsing();

    const builder = freeze({
      returning: (selector?: unknown, ...names: unknown[]) =>
        build(
          derive(() =>
            freeze({
              ...state,
              selection: readSelection(
                ownOccurrences(
                  () => bindings,
                  () =>
                    returningProjection(
                      returningSelector(selector, names) as never,
                      columnsOnly(root.table, scope[root.alias]!, "RETURNING"),
                      root.table,
                    ),
                ),
                bindings,
              ),
            }),
          ),
        ),
      where: (
        callback: (
          row: RuntimeScope[string],
        ) => Predicate | readonly Predicate[],
      ) => {
        if (kind === "insert") {
          throw new Error("symmetria: INSERT has no WHERE clause");
        }

        const next = derive(() => {
          const { description, filter } = wherePredicate(callback);
          const everyRow = truth(filter, root) === true;
          const filtered =
            !everyRow || !!state.unrestricted || conditioned(state);

          if (filter !== description) {
            movedFilters.set(description, filter);
          }

          // A filter that holds for every row is a missing filter: the write
          // would reach the whole table without saying so. Request values
          // often empty it (`[userId && …]`), so it is refused when the write
          // runs, like a missing where(), and reaches the write's catch(). A
          // condition from another where() or the lookup makes it a filter;
          // all(), before or after, confirms every row. A prepared write is
          // checked again with the values of each execution.
          if (!filtered) {
            const refusal = everyRowRefusal(
              kind,
              [filter, ...state.predicates]
                .filter((description) => description.kind !== "scope")
                .map((description) =>
                  emptiedBy(movedFilters.get(description) ?? description, root),
                )
                .find((emptied) => emptied),
            );
            everyRowErrors.add(refusal);
            dataError(refusal);
          }

          const { failure: earlier, ...rest } = state;

          return freeze({
            ...(earlier &&
            !(filtered && everyRowErrors.has(earlier.error as object))
              ? state
              : rest),
            predicates: freeze([...state.predicates, description]),
          });
        });

        return build(next);
      },
      all: () => {
        if (kind === "insert") {
          throw new Error("symmetria: all() applies to UPDATE and DELETE");
        }

        // Every row is what all() asks for: it lifts the refusal of a where()
        // that holds for every row.
        const { failure, ...rest } = state;

        return build(
          freeze({
            ...(failure && everyRowErrors.has(failure.error as object)
              ? rest
              : state),
            unrestricted: true as const,
          }),
        );
      },
      onConflict: (...names: string[]) => {
        if (kind !== "insert") {
          throw new Error(
            "symmetria: ON CONFLICT is only available for INSERT",
          );
        }

        // A single name that is no column may be a unique index, as by.<name> names it.
        const index =
          names.length === 1 &&
          !root.table.columns.some((column) => column.name === names[0])
            ? uniqueColumnIndexes(root.table).find(
                (definition) => definition.name === names[0],
              )
            : undefined;
        const columns = index
          ? index.columns
          : names.map((name) => {
              const column = root.table.columns.find(
                (column) => column.name === name,
              );

              if (!column) {
                throw new Error(
                  `symmetria: unknown conflict column "${name}"; the target is columns or the name of a unique key`,
                );
              }

              return column;
            });

        if (new Set(names).size !== names.length) {
          throw new Error("symmetria: duplicate conflict columns");
        }

        return freeze({
          doNothing: () =>
            build(
              freeze({
                ...state,
                conflict: freeze({
                  columns: freeze(columns),
                  action: "nothing",
                  values: freeze({}),
                }),
              }),
            ),
          doUpdate: (
            values:
              | string
              | Record<string, unknown>
              | ((
                  row: RuntimeScope[string],
                  excluded: RuntimeScope[string],
                ) => Record<string, unknown>),
            ...rest: unknown[]
          ) => {
            if (!columns.length) {
              throw new Error("symmetria: DO UPDATE requires conflict columns");
            }

            // `doUpdate(values, { where })` vs `doUpdate("name", "active")`.
            const conditional =
              typeof values !== "string" &&
              rest.length === 1 &&
              rest[0] !== null &&
              typeof rest[0] === "object";
            const names = conditional ? [] : (rest as string[]);
            const where = conditional
              ? (rest[0] as { where?: unknown }).where
              : undefined;

            if (
              conditional &&
              (typeof where !== "function" ||
                Object.keys(rest[0] as object).some((key) => key !== "where"))
            ) {
              throw new Error(
                "symmetria: doUpdate() options accept a where callback only",
              );
            }

            if (
              typeof values === "string"
                ? new Set([values, ...names]).size !== names.length + 1
                : names.some((name) => typeof name !== "string") ||
                  (names.length > 0 && !conditional)
            ) {
              throw new Error(
                "symmetria: doUpdate() requires distinct column names or a single values object/callback",
              );
            }

            if (root.alias === "excluded") {
              throw new Error(
                "symmetria: the table alias 'excluded' conflicts with PostgreSQL's upsert row",
              );
            }

            const excluded = freeze({ ...root, alias: "excluded" });
            const conflictScope = createScope({ ...bindings, excluded });

            // The plan's scope checks also guard the conflicting row.
            return build(
              derive(() => {
                rejectDuplicateKeys(root, columns, state.values);

                const condition = where
                  ? (() => {
                      const result = ownOccurrences(
                        () => ({ ...bindings, excluded }),
                        () =>
                          (
                            where as (
                              row: RuntimeScope[string],
                              excluded: RuntimeScope[string],
                            ) => Predicate | PredicateList
                          )(
                            conflictScope[root.alias]!,
                            conflictScope.excluded!,
                          ),
                      );
                      const description = readPredicate(
                        Array.isArray(result)
                          ? and(...(result as PredicateList))
                          : (result as Predicate),
                      );
                      validatePredicate(description, {
                        ...bindings,
                        excluded,
                      });

                      return description;
                    })()
                  : undefined;

                return freeze({
                  ...state,
                  conflict: freeze({
                    columns: freeze(columns),
                    action: "update" as const,
                    excluded,
                    ...(condition ? { condition } : {}),
                    values: readValues(
                      typeof values === "string"
                        ? Object.fromEntries(
                            [values, ...names].map((name) => [
                              name,
                              conflictScope.excluded![name],
                            ]),
                          )
                        : typeof values === "function"
                          ? ownOccurrences(
                              () => ({ ...bindings, excluded }),
                              () =>
                                values(
                                  conflictScope[root.alias]!,
                                  conflictScope.excluded!,
                                ),
                            )
                          : values,
                    ),
                  }),
                });
              }),
            );
          },
        });
      },
      toSQL: () => compileQuery(state),
      prepare: () => preparePlan(state, executor, undefined, [], executeUsing),
      [PREPARE_QUERY]: (scope: object, names: readonly string[]) =>
        checkedPrepared(
          state,
          preparePlan(state, executor, scope, names, executeUsing),
        ),
      execute,
      [Symbol.toStringTag]: WRITE_TAG,
      then: (
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) => execute().then(onFulfilled, onRejected),
      catch: (onRejected?: ((reason: unknown) => unknown) | null) =>
        execute().catch(onRejected),
      finally: (onFinally?: (() => void) | null) =>
        execute().finally(onFinally),
    });

    return profile ? profile.trackBuilder(builder) : builder;
  };

  const error = options.failure ?? failure;

  return build(error ? freeze({ ...initial, failure: error }) : initial);
};
