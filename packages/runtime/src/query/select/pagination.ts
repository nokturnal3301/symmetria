import { createHash } from "node:crypto";
import { ARRAY_DIMENSIONS } from "../codecs";
import { canonicalType } from "../codecs/type-names";
import { compileShape, executePlan } from "../compile";
import type { PredicateDescription, ValueNode } from "../expressions";
import type {
  OrderingDescription,
  QueryExecutor,
  SelectPlan,
  TableBinding,
} from "../plan/types";
import { derivedBinding } from "../plan/derived";
import { postgresRenderer } from "../compile/postgres/render";
import { expressionSqlType } from "../plan/metadata";
import { childNodes, containsNode } from "../plan/traverse";
import { primaryKeyColumns } from "../../schema/assembly";

/** What a cursor needs to know about each ORDER BY position. */
type CursorColumn = {
  readonly name: string;
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly unique: boolean;
  /** Set for ORDER BY expressions that are not plain columns. */
  readonly expression?: true;
};

/** True when the expression reads root columns only: it can be re-evaluated per row by the cursor predicate. */
const rootExpression = (node: ValueNode, root: TableBinding): boolean => {
  switch (node.kind) {
    case "column":
      return node.description.binding === root;
    case "parameter":
    case "placeholder":
    case "case":
    case "coalesce":
    case "tuple":
    case "binary":
    case "raw":
    case "jsonPath":
    case "arrayIndex":
    case "arrayLength":
      return childNodes(node).every((child) => rootExpression(child, root));
    // An allow-list: any other kind is not known to be a per-row expression.
    default:
      return false;
  }
};

const opaqueSQL = (node: ValueNode): boolean =>
  node.kind === "raw" && !node.composed;

/** A plan that asks for no row lock, by its type: a lock cannot be passed on by a spread. */
type UnlockedPlan = Omit<SelectPlan, "locking"> & { readonly locking?: never };

/**
 * Apply keyset predicates after windows have seen the complete filtered input.
 * The plan is selected twice, as the derived table and as the page read from
 * it, so it arrives without a row lock: a lock copied to both levels would
 * take every filtered row, not the page.
 */
const windowPagePlan = (plan: UnlockedPlan): SelectPlan => {
  const occupied = new Set(
    plan.selection.map((expression) => expression.outputName),
  );
  const keys = plan.ordering.map((ordering, position) => {
    let name = `__symmetria_order_${position}`;

    while (occupied.has(name)) {
      name += "_";
    }

    occupied.add(name);

    return { ...ordering.expression, outputName: name };
  });
  const root = derivedBinding(
    { ...plan, selection: [...plan.selection, ...keys], ordering: [] },
    "__symmetria_page",
  );

  const column = (name: string): ValueNode => ({
    kind: "column",
    description: {
      binding: root,
      column: root.table.columns.find((column) => column.name === name)!,
    },
  });

  return {
    ...plan,
    root,
    bindings: { [root.alias]: root },
    predicates: [],
    selection: plan.selection.map((expression) => ({
      ...expression,
      node: column(expression.outputName),
    })),
    ordering: plan.ordering.map((ordering, position) => ({
      ...ordering,
      expression: {
        ...ordering.expression,
        node: column(keys[position]!.outputName),
      },
    })),
  };
};

declare const CURSOR_RESULT: unique symbol;

const fingerprints = new WeakMap<SelectPlan, string>();

/** A zone offset as PostgreSQL reads it: `+05`, `+0530`, `+05:30`, `+05:30:15` or `Z`. */
const ZONE = String.raw`(Z|[+-]\d{2}(?::?\d{2}|:\d{2}:\d{2})?)?`;
const TIMESTAMP = new RegExp(
  String.raw`^(\d{4,7})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?${ZONE})?( BC)?$`,
);
const TIME = new RegExp(
  String.raw`^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?${ZONE}$`,
);
const NUMBER = /^-?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d{1,6}))?$/i;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAY_MICROSECONDS = 86_400_000_000;

/** Whether an integer fits a signed type of that many bits. */
const fits = (value: bigint, bits: bigint): boolean =>
  value >= -(1n << (bits - 1n)) && value < 1n << (bits - 1n);

/** Whether PostgreSQL reads the offset: it takes up to 15:59:59 either way. */
const zoneSeconds = (zone: string): number | undefined => {
  const [hours = 0, minutes = 0, seconds = 0] = (
    zone.match(/\d{2}/g) ?? []
  ).map(Number);

  return hours <= 15 && minutes <= 59 && seconds <= 59
    ? (zone.startsWith("-") ? -1 : 1) * ((hours * 60 + minutes) * 60 + seconds)
    : undefined;
};

/**
 * Microseconds into the day. PostgreSQL reads a leap second (`:60`) and
 * `24:00:00`, and nothing past the end of the day.
 */
const dayMicroseconds = (
  hour: string,
  minute: string,
  second: string,
  fraction = "",
): number | undefined => {
  const microseconds =
    ((Number(hour) * 60 + Number(minute)) * 60 + Number(second)) * 1_000_000 +
    Number(fraction.padEnd(6, "0"));

  return Number(minute) <= 59 &&
    Number(second) <= 60 &&
    microseconds <= DAY_MICROSECONDS
    ? microseconds
    : undefined;
};

/** Days from 1970-01-01 to a date of the Gregorian calendar extended backward; year 0 is 1 BC. */
const dayNumber = (year: number, month: number, day: number): number => {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear =
    Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;

  return (
    era * 146_097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear -
    719_468
  );
};

// What PostgreSQL stores: dates from 4714-11-24 BC to 5874897-12-31,
// timestamps from the same first day to the end of 294276.
const FIRST_DAY = dayNumber(-4713, 11, 24);
const DATE_END = dayNumber(5_874_898, 1, 1);
const TIMESTAMP_END = dayNumber(294_277, 1, 1);

/**
 * A date or timestamp in ISO form, as PostgreSQL prints it: a real calendar
 * day (there is no year 0000, and `BC` years have their own leap days), a
 * time and a zone offset it reads, and a moment the type can hold.
 */
const dateTimeMatches = (
  type: "date" | "timestamp" | "timestamptz" | undefined,
  value: string,
): boolean => {
  if (value === "infinity" || value === "-infinity") {
    return true;
  }

  const parts = TIMESTAMP.exec(value);

  if (!parts) {
    return false;
  }

  const year = parts[9] ? 1 - Number(parts[1]) : Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const time =
    parts[4] === undefined
      ? 0
      : dayMicroseconds(parts[4], parts[5]!, parts[6]!, parts[7]);
  const offset = parts[8] === undefined ? 0 : zoneSeconds(parts[8]);

  if (
    Number(parts[1]) === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > MONTH_DAYS[month - 1]! + (month === 2 && leap ? 1 : 0) ||
    time === undefined ||
    offset === undefined
  ) {
    return false;
  }

  const days = dayNumber(year, month, day);

  if (type === "date") {
    return days >= FIRST_DAY && days < DATE_END;
  }

  // The widest of the three types, a day either way for a zone offset.
  if (type === undefined) {
    return days >= FIRST_DAY - 1 && days <= DATE_END;
  }

  // A timestamp with time zone is held to its moment in UTC; printed without
  // an offset it is read in the session's zone, a day either way at most.
  const zoned = type === "timestamptz";
  const moment =
    days +
    Math.floor((time - (zoned ? offset * 1_000_000 : 0)) / DAY_MICROSECONDS);
  const slack = zoned && parts[8] === undefined ? 1 : 0;

  return moment >= FIRST_DAY - slack && moment < TIMESTAMP_END + slack;
};

/** A time of day as PostgreSQL prints it, `HH:MM:SS[.ffffff]` with an offset for `timetz`. */
const timeMatches = (value: string): boolean => {
  const parts = TIME.exec(value);

  return (
    !!parts &&
    dayMicroseconds(parts[1]!, parts[2]!, parts[3]!, parts[4]) !== undefined &&
    (parts[5] === undefined || zoneSeconds(parts[5]) !== undefined)
  );
};

// PostgreSQL prints an interval in the session's IntervalStyle and reads all
// four styles back, so each one's form is a real cursor value:
// `1 year 2 mons -3 days +04:05:06.789` (postgres),
// `@ 1 year 2 mons 3 days 4 hours 5 mins 6.789 secs ago` (postgres_verbose),
// `P1Y2M3DT4H5M6.789S` (iso_8601) and `1-2`, `-3 4:05:06`, `+1-2 -3 +4:05:06`
// (sql_standard). A value is matched after a leading space, so that every
// part of the first form starts with one.
const INTERVAL_FORMS = [
  /^(?: (?<Y>[+-]?\d{1,10}) years?)?(?: (?<M>[+-]?\d{1,2}) mons?)?(?: (?<D>[+-]?\d{1,10}) days?)?(?: (?<t>[+-]?)(?<h>\d{2,10}):(?<m>\d\d):(?<s>\d\d)(?:\.(?<f>\d{1,6}))?)?$/,
  /^ @(?= -?\d)(?: (?<Y>-?\d{1,10}) years?)?(?: (?<M>-?\d{1,2}) mons?)?(?: (?<D>-?\d{1,10}) days?)?(?: (?<h>-?\d{1,10}) hours?)?(?: (?<m>-?\d{1,2}) mins?)?(?: (?<s>-?\d{1,2})(?:\.(?<f>\d{1,6}))? secs?)?(?<ago> ago)?$/,
  /^ P(?=T?-?\d)(?:(?<Y>-?\d{1,10})Y)?(?:(?<M>-?\d{1,2})M)?(?:(?<D>-?\d{1,10})D)?(?:T(?=-?\d)(?:(?<h>-?\d{1,10})H)?(?:(?<m>-?\d{1,2})M)?(?:(?<s>-?\d{1,2})(?:\.(?<f>\d{1,6}))?S)?)?$/,
  /^ (?<all>-?)(?<Y>\d{1,10})-(?<M>\d{1,2})$/,
  /^ (?<all>-?)(?:(?<D>\d{1,10}) )?(?<h>\d{1,10}):(?<m>\d\d):(?<s>\d\d)(?:\.(?<f>\d{1,6}))?$/,
  /^ (?<y>[+-])(?<Y>\d{1,10})-(?<M>\d{1,2}) (?<D>[+-]\d{1,10}) (?<t>[+-])(?<h>\d{1,10}):(?<m>\d\d):(?<s>\d\d)(?:\.(?<f>\d{1,6}))?$/,
];

/**
 * An interval in a form PostgreSQL prints, with fields it can store: the
 * months and the days in 32 bits each, the time in 64 bits of microseconds.
 */
const intervalMatches = (value: string): boolean => {
  // Printed so by PostgreSQL 17 and later.
  if (value === "infinity" || value === "-infinity") {
    return true;
  }

  // A zero interval: `@ 0` in postgres_verbose, `0` in sql_standard.
  if (value === "@ 0" || value === "0") {
    return true;
  }

  for (const form of INTERVAL_FORMS) {
    const fields = form.exec(` ${value}`)?.groups;

    if (!fields) {
      continue;
    }

    const count = (text: string | undefined) => BigInt(text ?? 0);
    const magnitude = (text: string | undefined) =>
      count(text?.replace(/^[+-]/, ""));
    const sign = (text: string | undefined) =>
      text?.startsWith("-") ? -1n : 1n;
    // `ago` and the one sign of a sql_standard value turn every field.
    const all = fields.all === "-" || fields.ago ? -1n : 1n;
    const months =
      all * sign(fields.y) * (count(fields.Y) * 12n + count(fields.M));
    const days = all * count(fields.D);
    // A fraction belongs to the seconds written before it, `-0.5` included.
    const microseconds =
      all *
      sign(fields.t) *
      ((count(fields.h) * 60n + count(fields.m)) * 60_000_000n +
        count(fields.s) * 1_000_000n +
        sign(fields.s) * count(fields.f?.padEnd(6, "0")));

    return (
      magnitude(fields.M) <= 11n &&
      magnitude(fields.m) <= 59n &&
      magnitude(fields.s) <= 59n &&
      fits(months, 32n) &&
      fits(days, 32n) &&
      fits(microseconds, 64n)
    );
  }

  return false;
};

/**
 * A number in decimal or exponent form that the type can hold. `numeric`
 * keeps up to 131072 digits before the decimal point and 16383 after it; a
 * float is refused by PostgreSQL when it overflows, or underflows to zero.
 */
const numberMatches = (
  type: "numeric" | "real" | "double precision",
  value: string,
): boolean => {
  if (/^(?:NaN|-?Infinity)$/i.test(value)) {
    return true;
  }

  const parts = NUMBER.exec(value);

  if (!parts) {
    return false;
  }

  const whole = parts[1] ?? "";
  const fraction = parts[2] ?? parts[3] ?? "";
  const exponent = Number(parts[4] ?? 0);
  const first = (whole + fraction).search(/[1-9]/);

  if (type === "numeric") {
    return (
      fraction.length - exponent <= 16_383 &&
      (first < 0 || whole.length - 1 - first + exponent <= 131_071)
    );
  }

  const number = type === "real" ? Math.fround(Number(value)) : Number(value);

  return Number.isFinite(number) && (number !== 0 || first < 0);
};

const INTEGER_TYPES: ReadonlySet<string> = new Set([
  "smallint",
  "integer",
  "bigint",
]);

/**
 * Cursor values are text renderings of the ordering columns; reject ones
 * PostgreSQL could not cast back, so a damaged or forged cursor is an invalid
 * cursor and not a database error. Every value PostgreSQL prints for a stored
 * value passes, also when the database's column is wider than the declared
 * one (an `int` already migrated to `bigint` while this process still runs
 * the old schema) or an ORDER BY expression's type is only the caller's word
 * for its SQL: a value is held to the widest type of its family, any integer
 * to bigint, a float to double precision, a date or timestamp to the widest
 * range of the three.
 */
const cursorValueMatches = (column: CursorColumn, value: string): boolean => {
  // PostgreSQL text holds no NUL character.
  if (value.includes("\0")) {
    return false;
  }

  const type = canonicalType(column.sqlType);

  // An array's text form; PostgreSQL checks its elements when it casts.
  if (type.endsWith("[]")) {
    return (
      (value.startsWith("{") || ARRAY_DIMENSIONS.test(value)) &&
      value.endsWith("}")
    );
  }

  // An enum label is PostgreSQL's to judge: the database may be a migration
  // ahead of this process and hold a label its schema does not list yet.

  if (INTEGER_TYPES.has(type)) {
    return /^-?\d{1,19}$/.test(value) && fits(BigInt(value), 64n);
  }

  if (/^numeric(?:\(|$)/.test(type)) {
    return numberMatches("numeric", value);
  }

  if (type === "real" || type === "double precision") {
    return numberMatches("double precision", value);
  }

  if (/^(?:timestamptz|timestamp|date)(?:\(|$)/.test(type)) {
    return dateTimeMatches(undefined, value);
  }

  if (/^(?:time|timetz)(?:\(|$)/.test(type)) {
    return timeMatches(value);
  }

  if (type === "interval") {
    return intervalMatches(value);
  }

  if (type === "uuid") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  if (type === "boolean") {
    return /^(?:t|f|true|false|0|1)$/.test(value);
  }

  return true;
};

export type PageCursor<Row> = string & { readonly [CURSOR_RESULT]: Row };
export type Page<Row> = {
  items: Row[];
  /** Cursor of the last item when rows follow it; `null` on the last page. */
  nextCursor: PageCursor<Row> | null;
  /** Cursor of the first item when rows precede it; `null` on the first page. */
  previousCursor: PageCursor<Row> | null;
};
export type PageOptions<Row> = {
  size: number;
  /** Rows after this cursor, in the declared order. */
  after?: PageCursor<Row> | null | undefined;
  /** Rows before this cursor, still returned in the declared order. */
  before?: PageCursor<Row> | null | undefined;
};

/** The reverse of an ORDER BY entry; an implicit NULLS placement is made explicit first so it flips too. */
const byDistance = ({ expression: { node } }: OrderingDescription): boolean =>
  node.kind === "binary" &&
  ["<->", "<=>", "<#>", "<+>"].includes(node.operator);

const reversed = (ordering: OrderingDescription): OrderingDescription => {
  const nulls =
    ordering.nulls ?? postgresRenderer.nullsDefault(ordering.direction);

  return {
    ...ordering,
    direction: ordering.direction === "ASC" ? "DESC" : "ASC",
    nulls: nulls === "FIRST" ? "LAST" : "FIRST",
  };
};

export const executePage = async (
  plan: SelectPlan,
  options: {
    size: number;
    after?: string | null | undefined;
    before?: string | null | undefined;
  },
  executor?: QueryExecutor,
): Promise<Page<Record<string, unknown>>> => {
  if (
    !Number.isSafeInteger(options.size) ||
    options.size < 1 ||
    options.size >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("symmetria: page size must be a positive safe integer");
  }

  if (options.after != null && options.before != null) {
    throw new Error(
      "symmetria: page() accepts either after or before, not both",
    );
  }

  const backward = options.before != null;
  const cursor = backward ? options.before : options.after;

  if (
    plan.joins.length ||
    plan.grouping.length ||
    plan.having.length ||
    plan.distinct ||
    plan.root.derived ||
    plan.offset !== undefined ||
    plan.limit !== undefined
  ) {
    throw new Error(
      "symmetria: page() requires an ungrouped root-table query without joins, LIMIT or OFFSET",
    );
  }

  // Cursor positions: plain root columns, or deterministic expressions over them
  // (computed fields, raw SQL). Expressions are treated as nullable, unknown-typed.
  const columns: CursorColumn[] = plan.ordering.map((ordering, position) => {
    const node = ordering.expression.node;

    if (node.kind === "column" && node.description.binding === plan.root) {
      return node.description.column;
    }

    if (!rootExpression(node, plan.root)) {
      throw new Error(
        "symmetria: page() ORDER BY accepts root columns and expressions over them only",
      );
    }

    return {
      name: `__symmetria_expression_${position}`,
      sqlType: expressionSqlType(ordering.expression),
      notNull: false,
      unique: false,
      expression: true,
    };
  });
  const names = columns.map((column) => column.name);
  const keys = primaryKeyColumns(plan.root.table);

  if (
    !names.length ||
    new Set(names).size !== names.length ||
    !(
      (keys.length && keys.every((column) => names.includes(column.name))) ||
      columns.some((column) => column.unique && column.notNull)
    )
  ) {
    throw new Error(
      "symmetria: page() ORDER BY must include a complete primary key or a non-null unique column",
    );
  }

  // The fingerprint names the query, not the $scope() values in force: a
  // cursor is accepted or refused the same way for a reused and a rebuilt
  // query, and the filters themselves still apply when the page runs.
  let fingerprint = fingerprints.get(plan);

  if (!fingerprint) {
    // JSON writes NaN and both infinities as null. Keep their positions and
    // signs outside the JSON, leaving existing ordinary cursors unchanged.
    const specials: [number, string][] = [];
    let slot = 0;
    const shape = JSON.stringify(compileShape(plan), (_name, value) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        specials.push([slot, String(value)]);
      }
      slot++;
      return typeof value === "bigint" ? { bigint: String(value) } : value;
    });
    const hash = createHash("sha256").update(shape);
    if (specials.length) {
      hash.update("\0").update(JSON.stringify(specials));
    }
    fingerprint = hash.digest("hex");
    fingerprints.set(plan, fingerprint);
  }

  const opaque =
    plan.selection.some(({ node }) => containsNode(node, opaqueSQL)) ||
    plan.ordering.some(({ expression }) =>
      containsNode(expression.node, opaqueSQL),
    );
  // A page with a row lock is read from the table itself, so the lock takes
  // the rows of the page and the one row read ahead. PostgreSQL refuses a row
  // lock beside a window function or a set-returning function in the select
  // list, and a lock on the wrapped form reaches every filtered row, so the
  // wrap could serve no locked page.
  const { locking, ...unlocked } = plan;
  const declaredPlan =
    !locking &&
    (opaque ||
      plan.selection.some(({ node }) =>
        containsNode(node, (candidate) => candidate.kind === "window"),
      ))
      ? windowPagePlan(unlocked)
      : plan;
  // Pages must cover every row once, which an approximate vector index does
  // not promise: `+ 0` is an ordering it cannot produce, so rows are compared
  // exactly.
  const exactPlan = plan.ordering.some(byDistance)
    ? {
        ...declaredPlan,
        ordering: declaredPlan.ordering.map(
          (ordering, position): OrderingDescription =>
            byDistance(plan.ordering[position]!)
              ? {
                  ...ordering,
                  expression: {
                    ...ordering.expression,
                    node: {
                      kind: "binary" as const,
                      left: ordering.expression.node,
                      operator: "+" as const,
                      right: { kind: "parameter" as const, value: 0 },
                      sqlType: "double precision",
                    },
                  },
                }
              : ordering,
        ),
      }
    : declaredPlan;
  // Backward pages run the reversed order and are flipped back before returning.
  const pagePlan = backward
    ? { ...exactPlan, ordering: exactPlan.ordering.map(reversed) }
    : exactPlan;
  const predicates = [...pagePlan.predicates];

  const cursorValue = (value: unknown, position: number): ValueNode => {
    const column = columns[position]!;

    return {
      kind: "parameter",
      value,
      ...(["json", "jsonb"].includes(column.sqlType)
        ? { cast: column.sqlType as "json" | "jsonb" }
        : {}),
    };
  };

  if (cursor != null) {
    let values: unknown[];

    try {
      if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error();
      }

      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());

      if (
        decoded.version !== 1 ||
        decoded.query !== fingerprint ||
        !Array.isArray(decoded.values) ||
        decoded.values.length !== columns.length ||
        decoded.values.some((value: unknown, position: number) =>
          value === null
            ? columns[position]!.notNull
            : typeof value !== "string" ||
              !cursorValueMatches(columns[position]!, value),
        )
      ) {
        throw new Error();
      }

      values = decoded.values;
    } catch {
      throw new Error(
        "symmetria: invalid page cursor or cursor from another query",
      );
    }

    if (
      columns.every((column) => column.notNull) &&
      pagePlan.ordering.every(
        (ordering) => ordering.direction === pagePlan.ordering[0]!.direction,
      )
    ) {
      const tuple = (nodes: ValueNode[]): ValueNode =>
        nodes.length === 1 ? nodes[0]! : { kind: "tuple", values: nodes };

      predicates.push({
        kind: "comparison",
        left: tuple(
          pagePlan.ordering.map((ordering) => ordering.expression.node),
        ),
        operator: pagePlan.ordering[0]!.direction === "ASC" ? ">" : "<",
        right: tuple(values.map(cursorValue)),
      });
    } else {
      const branches: PredicateDescription[] = [];
      const prefix: PredicateDescription[] = [];
      pagePlan.ordering.forEach((ordering, position) => {
        const expression = ordering.expression;
        const value = values[position];
        const nullsFirst =
          (ordering.nulls ??
            postgresRenderer.nullsDefault(ordering.direction)) === "FIRST";
        const following: PredicateDescription =
          value === null
            ? nullsFirst
              ? { kind: "nullCheck", value: expression.node, negated: true }
              : { kind: "group", operator: "OR", predicates: [] }
            : {
                kind: "group",
                operator: "OR",
                predicates: [
                  {
                    kind: "comparison",
                    left: expression.node,
                    operator: ordering.direction === "ASC" ? ">" : "<",
                    right: cursorValue(value, position),
                  },
                  ...(!nullsFirst && !columns[position]!.notNull
                    ? [
                        {
                          kind: "nullCheck" as const,
                          value: expression.node,
                          negated: false,
                        },
                      ]
                    : []),
                ],
              };
        branches.push({
          kind: "group",
          operator: "AND",
          predicates: [...prefix, following],
        });
        prefix.push({
          kind: "comparison",
          left: expression.node,
          operator: "IS NOT DISTINCT FROM",
          right: cursorValue(value, position),
        });
      });
      predicates.push({ kind: "group", operator: "OR", predicates: branches });
    }
  }

  const occupied = new Set(
    plan.selection.map((expression) => expression.outputName),
  );
  const textCast = postgresRenderer.textCast;
  const hidden = pagePlan.ordering.map((ordering, position) => {
    let name = `__symmetria_cursor_${position}`;

    while (occupied.has(name)) {
      name += "_";
    }

    occupied.add(name);

    // PostgreSQL text preserves timestamp microseconds and custom storage values,
    // independently of lossy application decoders (such as JavaScript Date).
    return {
      outputName: name,
      node: {
        kind: "raw" as const,
        parts: [
          ...(textCast.prefix ? [textCast.prefix] : []),
          ordering.expression.node,
          textCast.suffix,
        ],
      },
    };
  });
  const result = await executePlan(
    {
      ...pagePlan,
      selection: [...pagePlan.selection, ...hidden],
      predicates,
      limit: options.size + 1,
    },
    executor,
  );
  if (opaque) {
    // A set-returning expression may emit several rows at the very same
    // cursor. Include the lookahead row so a tie across a page boundary is
    // detected before returning a cursor that would skip the remaining rows.
    for (let i = 1; i < result.rows.length; i++) {
      if (
        hidden.every(
          ({ outputName }) =>
            result.rows[i - 1]![outputName] === result.rows[i]![outputName],
        )
      ) {
        throw new Error(
          "symmetria: page() requires a unique cursor for each result row; use stream() for a projection that returns multiple rows per key",
        );
      }
    }
  }
  const fetched = result.rows.slice(0, options.size);
  const more = result.rows.length > options.size;
  const rows = backward ? fetched.reverse() : fetched;
  const encode = (row: Record<string, unknown>) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        query: fingerprint,
        values: hidden.map((expression) => row[expression.outputName]),
      }),
    ).toString("base64url") as PageCursor<Record<string, unknown>>;
  const first = rows[0];
  const last = rows.at(-1);
  // Paging backward from a cursor proves rows follow; paging forward from one proves rows precede.
  const nextCursor = last && (backward || more) ? encode(last) : null;
  const previousCursor =
    first && (backward ? more : options.after != null) ? encode(first) : null;

  return {
    items: rows.map((row) =>
      Object.fromEntries(
        plan.selection.map((expression) => [
          expression.outputName,
          row[expression.outputName],
        ]),
      ),
    ),
    nextCursor,
    previousCursor,
  };
};
