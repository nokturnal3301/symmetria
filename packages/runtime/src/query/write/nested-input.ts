/**
 * The input of a nested insert, read before anything runs: values are
 * encoded and the graph is copied, so later changes to the caller's objects
 * cannot reach the statements, and the rows it connects are collected.
 */
import {
  primaryKeyColumns,
  uniqueColumnIndexes,
  type SchemaSnapshot,
  type TableSnapshot,
} from "../../schema/assembly";
import { cloneParameter, type SchemaCodecs } from "../codecs";
import { canonicalType } from "../codecs/type-names";
import {
  COLUMN_EXPRESSION,
  createExpression,
  readColumn,
  valueNode,
  type SelectedColumn,
  type ValueNode,
} from "../expressions";
import { quoteIdentifier } from "../compile/state";
import { freeze } from "../plan/freeze";

/** Types a read returns exactly as stored, so a key read back is written as it is. */
const READ_EXACTLY =
  /^(?:integer|smallint|bigint|text|uuid|boolean|varchar(?:\(\d+\))?)$/;

/** Dates and timestamps, which `to_json()` writes in ISO form whatever the DateStyle. */
const STAMP = /^(?:timestamptz|timestamp|date)(?:\(\d+\))?$/;
/** Ranges and multiranges of dates and timestamps. */
const STAMP_RANGE = /^(?:tstz|ts|date)range$/;
const STAMP_MULTIRANGE = /^(?:tstz|ts|date)multirange$/;
const FLOAT = /^(?:double precision|real)$/;

/** `$V` stands for the value in these forms. */
const STAMP_TEXT = "(to_json($V)#>>'{}')";
/** All 17 digits whatever extra_float_digits. */
const FLOAT_TEXT =
  "(CASE WHEN abs($V) < 'Infinity' THEN to_char($V, '9.9999999999999999EEEE') ELSE ($V)::text END)";
/** A range literal of ISO bounds; NULL for NULL. */
const RANGE_TEXT =
  "(CASE WHEN isempty($V) THEN 'empty' WHEN NOT isempty($V) THEN format('%s%s,%s%s', CASE WHEN lower_inc($V) THEN '[' ELSE '(' END, to_json(lower($V)), to_json(upper($V)), CASE WHEN upper_inc($V) THEN ']' ELSE ')' END) END)";
const MULTIRANGE_TEXT = `(CASE WHEN $V IS NOT NULL THEN '{' || array_to_string(ARRAY(SELECT ${RANGE_TEXT.replaceAll("$V", '"__symmetria_key_range"."r"')} FROM unnest($V) WITH ORDINALITY AS "__symmetria_key_range"("r", "o") ORDER BY "__symmetria_key_range"."o"), ',') || '}' END)`;
/**
 * An array of dates or timestamps: its JSON (ISO elements, `null`, nested
 * arrays for more dimensions) as an array literal, with its bounds.
 */
const STAMP_ARRAY_TEXT =
  "(coalesce(array_dims($V) || '=', '') || translate(to_json($V)::text, '[]', '{}'))";

/**
 * A one-dimensional array as a literal of its elements' texts, each written
 * by `element` (with `$E` for the element) and quoted; an array of more
 * dimensions as PostgreSQL prints it.
 */
const elementsText = (element: string): string =>
  `(CASE WHEN array_ndims($V) > 1 THEN ($V)::text WHEN $V IS NOT NULL THEN coalesce(array_dims($V) || '=', '') || '{' || array_to_string(ARRAY(SELECT coalesce('"' || replace(replace(${element.replaceAll("$V", '"__symmetria_key_element"."e"')}, E'\\\\', E'\\\\\\\\'), '"', E'\\\\"') || '"', 'NULL') FROM unnest($V) WITH ORDINALITY AS "__symmetria_key_element"("e", "o") ORDER BY "__symmetria_key_element"."o"), ',') || '}' END)`;

const ELEMENT_TEXTS = new Map<RegExp, string>([
  [STAMP_RANGE, elementsText(RANGE_TEXT)],
  [STAMP_MULTIRANGE, elementsText(MULTIRANGE_TEXT)],
  [FLOAT, elementsText(FLOAT_TEXT)],
]);

/**
 * A value of a type (in the runtime's spelling, a customType's `base` where
 * it declares one) as text that reads back as exactly that value in any
 * session, as SQL parts around the value. Dates and timestamps are written
 * in ISO form whatever the DateStyle (`SQL` names the zone by an
 * abbreviation such as CST, which PostgreSQL reads back as another zone),
 * also in arrays, ranges and multiranges; doubles and reals with all 17
 * digits whatever extra_float_digits; other types as PostgreSQL prints
 * them, which reads back in the same session.
 */
export const exactTextParts = (
  type: string,
  value: ValueNode | string,
): (ValueNode | string)[] => {
  let strings = exactTexts.get(type);

  if (!strings) {
    strings = exactTextStrings(type);

    // Types come from declarations, so the map stays small; bound it anyway.
    if (exactTexts.size < 1024) {
      exactTexts.set(type, strings);
    }
  }

  return strings.flatMap((text, index) => (index ? [value, text] : [text]));
};

const exactTexts = new Map<string, readonly string[]>();

/** The SQL around the value in `exactTextParts()`, split where it goes. */
const exactTextStrings = (type: string): readonly string[] => {
  const element = type.replace(/(?:\[\])+$/, "");
  const sql =
    element === type
      ? STAMP.test(type)
        ? STAMP_TEXT
        : STAMP_RANGE.test(type)
          ? RANGE_TEXT
          : STAMP_MULTIRANGE.test(type)
            ? MULTIRANGE_TEXT
            : FLOAT.test(type)
              ? FLOAT_TEXT
              : "($V)::text"
      : STAMP.test(element)
        ? STAMP_ARRAY_TEXT
        : ([...ELEMENT_TEXTS].find(([pattern]) => pattern.test(element))?.[1] ??
          "($V)::text");

  return Object.freeze(sql.split("$V"));
};

/**
 * A Date or binary value (Uint8Array, Buffer): a key value as a whole, such
 * as a timestamptz or bytea primary key, never an object of key columns.
 */
const keyValueObject = (value: object): boolean =>
  value instanceof Date ||
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer;

/** Plain decimal text, as numeric and bigint values are written: sign, digits, fraction. */
const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Two plain decimals by value; undefined when either is not one. */
const compareDecimals = (left: string, right: string): number | undefined => {
  const a = DECIMAL.exec(left);
  const b = DECIMAL.exec(right);

  if (!a || !b || !(a[2] || a[3]) || !(b[2] || b[3])) {
    return undefined;
  }

  const digits = (match: RegExpExecArray) => {
    const whole = match[2]!.replace(/^0+/, "");
    const fraction = (match[3] ?? "").replace(/0+$/, "");

    return { whole, fraction, zero: !whole && !fraction };
  };
  const x = digits(a);
  const y = digits(b);
  const sign = (match: RegExpExecArray, value: { zero: boolean }) =>
    value.zero ? 0 : match[1] === "-" ? -1 : 1;
  const signs = sign(a, x) - sign(b, y);

  if (signs) {
    return Math.sign(signs);
  }

  const magnitude =
    x.whole.length !== y.whole.length
      ? x.whole.length - y.whole.length
      : x.whole !== y.whole
        ? x.whole < y.whole
          ? -1
          : 1
        : x.fraction === y.fraction
          ? 0
          : x.fraction < y.fraction
            ? -1
            : 1;

  return Math.sign(magnitude) * sign(a, x);
};

/** A key value as sent: what an encoded expression binds, or the value itself. */
const sentValue = (value: unknown): unknown => {
  if (value && typeof value === "object" && COLUMN_EXPRESSION in value) {
    const { node } = readColumn(value as SelectedColumn);

    return node.kind === "parameter" ? node.value : undefined;
  }

  return value;
};

/**
 * A key value as text to sort by, and its rank: numbers, bigints, booleans
 * (as 0 and 1) and decimal text (0) sort by value, other text and Dates (1) by UTF-16 code units of
 * the text and the UTC ISO form, anything else (2) by its JSON or hex text.
 */
const sortForm = (value: unknown): [rank: number, text: string] => {
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return [0, String(typeof value === "boolean" ? Number(value) : value)];
  }

  if (typeof value === "string") {
    return [DECIMAL.test(value) && /\d/.test(value) ? 0 : 1, value];
  }

  if (value instanceof Date) {
    return [1, Number.isNaN(value.getTime()) ? "" : value.toISOString()];
  }

  return [
    2,
    ArrayBuffer.isView(value)
      ? Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("")
      : (JSON.stringify(value, (_key, entry) =>
          typeof entry === "bigint" ? entry.toString() : entry,
        ) ?? String(value)),
  ];
};

/**
 * Key values in one order that does not depend on the process (never on a
 * locale or time zone), so concurrent inserts lock the same rows in the same
 * order. Equal numbers spelled differently ("1.50", 1.5) sort next to each
 * other, then by their text.
 */
const compareKeyValues = (left: unknown, right: unknown): number => {
  const [leftRank, a] = sortForm(left);
  const [rightRank, b] = sortForm(right);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (leftRank === 0) {
    // 1e21 and NaN have no plain decimal form; they sort as numbers.
    const order =
      compareDecimals(a, b) ??
      (Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0);

    if (order) {
      return order;
    }
  }

  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Key values, one per key column, in the order connectOrCreate entries are
 * resolved in. Undefined when a value has no known form (a `sql` template).
 */
export const keySortValues = (
  values: readonly unknown[],
): readonly unknown[] | undefined => {
  const sent = values.map(sentValue);

  return sent.some((value) => value === undefined || value === null)
    ? undefined
    : sent;
};

/** Composite keys compare column by column. */
export const compareKeys = (
  left: readonly unknown[],
  right: readonly unknown[],
): number => {
  for (let position = 0; position < left.length; position += 1) {
    const order = compareKeyValues(left[position], right[position]);

    if (order) {
      return order;
    }
  }

  return 0;
};

/** Keys a row can be found by: the primary key first, then unique columns and indexes. */
export const uniqueKeys = (table: TableSnapshot): string[][] => {
  const primary = primaryKeyColumns(table).map((column) => column.name);

  return [
    ...(primary.length ? [primary] : []),
    ...table.columns
      .filter((column) => column.unique)
      .map((column) => [column.name]),
    ...uniqueColumnIndexes(table).map(({ columns }) =>
      columns.map((column) => column.name),
    ),
  ];
};

const copyInput = (value: unknown, ancestors = new Set<object>()): unknown => {
  if (!value || typeof value !== "object" || COLUMN_EXPRESSION in value) {
    return value;
  }

  if (
    value instanceof Date ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  ) {
    return cloneParameter(value);
  }

  if (ancestors.has(value)) {
    throw new Error("symmetria: cyclic nested insert input");
  }

  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => copyInput(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          copyInput(entry, ancestors),
        ]),
      );
  ancestors.delete(value);

  return freeze(result);
};

/** Write payloads treat `undefined` as an omitted field or operation. */
const definedEntries = (value: object): [string, unknown][] =>
  Object.entries(value).filter(([, entry]) => entry !== undefined);

/** Condition relations have no foreign key, so nested writes cannot target them. */
export const conditionWrite = (table: string, field: string): Error =>
  new Error(
    `symmetria: "${table}.${field}" is a condition relation; it has no foreign key to write`,
  );

/** Readers of one nested insert's input, bound to its schema and root table. */
export const nestedInput = (
  snapshot: SchemaSnapshot,
  tableName: string,
  codecs: SchemaCodecs,
) => {
  const tableByName = new Map(
    snapshot.tables.map((table) => [table.name, table]),
  );

  // A value with a codec is encoded before the graph is copied: copyInput()
  // makes a plain object of a class instance, without its prototype or
  // private state.
  const scalar = (name: string, column: string, value: unknown): unknown => {
    const codec = codecs[name]?.[column];

    if (
      !codec ||
      value === null ||
      value === undefined ||
      typeof value === "symbol"
    ) {
      return copyInput(value);
    }

    return createExpression({
      outputName: column,
      node: valueNode(value, codec),
    });
  };

  /** The target column a foreign key points at, when the schema has it. */
  const referencedColumn = (
    sourceName: string,
    foreignKey: string,
    targetName: string,
  ) => {
    const column = tableByName
      .get(sourceName)
      ?.columns.find((entry) => entry.name === foreignKey);

    return tableByName
      .get(targetName)
      ?.columns.find((entry) => entry.sqlName === column?.references?.column);
  };

  /** The target column a foreign key points at, by TypeScript name. */
  const referencedName = (
    sourceName: string,
    foreignKey: string,
    targetName: string,
  ): string => {
    const target = referencedColumn(sourceName, foreignKey, targetName);

    if (!target) {
      throw new Error(
        `symmetria: missing foreign key metadata for "${sourceName}.${foreignKey}"`,
      );
    }

    return target.name;
  };

  const textKeys = new Map<string, readonly string[]>();

  /**
   * Whether a read returns the column's value exactly as stored, so equal
   * values read back are equal in JavaScript: no codec, and a type such as
   * integer, text or uuid.
   */
  const readsExactly = (name: string, column: string): boolean => {
    const entry = tableByName
      .get(name)
      ?.columns.find((candidate) => candidate.name === column);

    return (
      !!entry &&
      codecs[name]?.[column] === undefined &&
      (!!entry.enumerationValues ||
        READ_EXACTLY.test(canonicalType(entry.sqlType)))
    );
  };

  /**
   * The key columns of a table (its primary key and the columns foreign keys
   * reference) whose value as read is not always the value stored: a
   * timestamp keeps microseconds a Date has not, a customType() decodes to a
   * value of its own, an interval reads in another spelling. Rows of the
   * insert are read with these as text, and foreign keys copy the text.
   */
  const textKeyColumns = (name: string): readonly string[] => {
    let columns = textKeys.get(name);

    if (!columns) {
      const table = tableByName.get(name)!;
      const keys = new Set(
        primaryKeyColumns(table).map((column) => column.name),
      );

      for (const source of snapshot.tables) {
        for (const relation of source.relations) {
          if (relation.kind === "one" && !relation.reverse) {
            if (relation.target === name) {
              keys.add(
                referencedColumn(source.name, relation.foreignKey, name)
                  ?.name ?? "",
              );
            }
          } else if (relation.kind === "through") {
            if (source.name === name) {
              keys.add(
                referencedColumn(
                  relation.junction,
                  relation.sourceForeignKey,
                  name,
                )?.name ?? "",
              );
            }

            if (relation.target === name) {
              keys.add(
                referencedColumn(
                  relation.junction,
                  relation.targetForeignKey,
                  name,
                )?.name ?? "",
              );
            }
          }
        }
      }

      columns = freeze(
        table.columns
          .filter(
            (column) =>
              keys.has(column.name) && !readsExactly(name, column.name),
          )
          .map((column) => column.name),
      );
      textKeys.set(name, columns);
    }

    return columns;
  };

  /** The stored text of key columns, for each row the insert has read or written. */
  const keyTexts = new WeakMap<object, Readonly<Record<string, unknown>>>();

  /**
   * A key column's value as text that reads back as the stored value in
   * any session (see `exactTextParts()`), by the column's type: a
   * customType's `base`, or its elements' for an array of one.
   */
  const textParts = (
    name: string,
    column: string,
    value: ValueNode | string,
  ): (ValueNode | string)[] => {
    const codec = codecs[name]?.[column];

    return exactTextParts(
      codec?.base ??
        (codec?.element?.base === undefined
          ? canonicalType(
              tableByName
                .get(name)!
                .columns.find((entry) => entry.name === column)!.sqlType,
            )
          : `${codec.element.base}[]`),
      value,
    );
  };

  /** A key column's value as text, as `textParts()` writes it. */
  const keyText = (
    name: string,
    row: Readonly<Record<string, unknown>>,
    column: string,
  ) =>
    createExpression({
      outputName: column,
      node: freeze({
        kind: "raw",
        parts: freeze(
          textParts(name, column, readColumn(row[column] as never).node),
        ),
        sqlType: "text",
      }),
    });

  /** The text of the key columns `textKeyColumns()` names, as a shape; undefined without any. */
  const keyShape = (
    name: string,
    row: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | undefined => {
    const columns = textKeyColumns(name);

    return columns.length
      ? Object.fromEntries(
          columns.map((column) => [column, keyText(name, row, column)]),
        )
      : undefined;
  };

  /** Keeps the key texts an INSERT returned with its row, for `keyValue()`. */
  const insertedRow = (inserted: {
    readonly row?: unknown;
    readonly keys?: unknown;
  }): Record<string, unknown> => {
    const row = inserted.row as Record<string, unknown>;

    if (inserted.keys) {
      keyTexts.set(row, inserted.keys as Record<string, unknown>);
    }

    return row;
  };

  const prefixes = new Map<string, string>();

  /**
   * The start of the names of the columns a row read adds to the table's own
   * (key texts, the position of the value a row matched): no column of the
   * table starts with it, so they never meet one in the row read.
   */
  const extraPrefix = (name: string): string => {
    let prefix = prefixes.get(name);

    if (prefix === undefined) {
      const { columns } = tableByName.get(name)!;
      let candidate = "__symmetria_key_";

      while (columns.some((column) => column.name.startsWith(candidate))) {
        candidate = `_${candidate}`;
      }

      prefixes.set(name, (prefix = candidate));
    }

    return prefix;
  };

  /** Values of one column a row read compares the row with, by PostgreSQL. */
  type Match = {
    readonly column: string;
    readonly values: readonly unknown[];
  };

  /**
   * The shape that reads a whole row of the table flat, as a plain read
   * does, so every column reaches its decoder in the form it always has,
   * with the text of its key columns as extra columns. With `match`, it also
   * reads the position of the first value the row's column equals, as
   * PostgreSQL compares them: a timestamptz key stored with microseconds
   * equals a Date only when they are zeros. The values are joined with the
   * table once, which PostgreSQL can hash or look up by index, and each row
   * finds its position by its text in what that join made, where a
   * `CASE column WHEN $1 …` would compare every row with every value.
   * `readRow()` takes the row out of what it read.
   */
  const rowShape = (
    name: string,
    row: Readonly<Record<string, unknown>>,
    match?: Match,
  ): Record<string, unknown> => {
    const columns = textKeyColumns(name);

    if (!columns.length && !match) {
      return { ...row };
    }

    const prefix = extraPrefix(name);
    const extra: [string, unknown][] = columns.map((column, position) => [
      `${prefix}${position}`,
      keyText(name, row, column),
    ]);

    if (match) {
      const { node, codec } = readColumn(row[match.column] as never);
      const table = quoteIdentifier(tableByName.get(name)!.sqlName);
      const column = quoteIdentifier(
        tableByName
          .get(name)!
          .columns.find((entry) => entry.name === match.column)!.sqlName,
      );
      const stored = `"__symmetria_key_row".${column}`;
      // The values stay untyped, as in a comparison with the column, so
      // nothing rounds them: the NULL read from the column gives the array
      // the column's type (a domain's base type), without its precision.
      const values = match.values.flatMap((value, index) => [
        index ? ", " : "",
        valueNode(value, codec),
      ]);
      const position: ValueNode = freeze({
        kind: "raw",
        parts: freeze([
          '((SELECT jsonb_object_agg("key", "position") FROM (SELECT ',
          ...textParts(name, match.column, stored),
          ' AS "key", min("__symmetria_key_values"."position") AS "position" FROM ',
          table,
          ' AS "__symmetria_key_row" JOIN unnest(ARRAY[',
          ...values,
          `, (SELECT "__symmetria_key_type".${column} FROM ${table} AS "__symmetria_key_type" LIMIT 0)]) WITH ORDINALITY AS "__symmetria_key_values"("value", "position") ON ${stored} = "__symmetria_key_values"."value" GROUP BY 1) AS "__symmetria_key_match") ->> (`,
          ...textParts(name, match.column, node),
          "))::integer - 1",
        ]),
        sqlType: "integer",
      });

      extra.push([
        `${prefix}match`,
        createExpression({ outputName: `${prefix}match`, node: position }),
      ]);
    }

    return { ...row, ...Object.fromEntries(extra) };
  };

  /**
   * The row a `rowShape()` read, its key texts kept for `keyValue()`, and
   * the position of the value it matched, when the read compared it.
   */
  const readRow = (
    name: string,
    read: Record<string, unknown>,
  ): Record<string, unknown> => {
    const columns = textKeyColumns(name);
    const prefix = extraPrefix(name);

    if (!columns.length && !Object.hasOwn(read, `${prefix}match`)) {
      return read;
    }

    const row = Object.fromEntries(
      Object.entries(read).filter(([field]) => !field.startsWith(prefix)),
    );

    keyTexts.set(
      row,
      Object.fromEntries(
        columns.map((column, position) => [
          column,
          read[`${prefix}${position}`],
        ]),
      ),
    );

    return row;
  };

  /** The position of the value a `rowShape()` read with `match` found the row by. */
  const matchedPosition = (
    name: string,
    read: Record<string, unknown>,
  ): number | undefined => {
    const position = read[`${extraPrefix(name)}match`];

    return position === null || position === undefined
      ? undefined
      : Number(position);
  };

  /**
   * The value a foreign key stores to reference this column of the row: the
   * value read, or, for a column read as text, that text cast back to the
   * column's type, so the key is the stored one to the last digit.
   */
  const keyValue = (
    name: string,
    row: Readonly<Record<string, unknown>>,
    column: string,
  ): unknown => {
    const texts = keyTexts.get(row);

    if (!texts || !Object.hasOwn(texts, column)) {
      return row[column];
    }

    const text = texts[column];

    if (text === null || text === undefined) {
      return null;
    }

    return createExpression({
      outputName: column,
      node: freeze({
        kind: "parameter",
        value: text,
        cast: tableByName
          .get(name)!
          .columns.find((entry) => entry.name === column)!.sqlType,
      }),
    });
  };

  /**
   * A row's primary key as `compareKeys()` orders rows to lock them: the
   * stored text of a column read as text (two keys a Date cannot tell apart
   * are two texts), the value read of any other.
   */
  const primarySortValues = (
    name: string,
    row: Readonly<Record<string, unknown>>,
  ): readonly unknown[] => {
    const texts = keyTexts.get(row);

    return primaryKeyColumns(tableByName.get(name)!).map(({ name: column }) =>
      texts && Object.hasOwn(texts, column) ? texts[column] : row[column],
    );
  };

  /**
   * The column a scalar connect value names: the referenced column of a forward
   * reference or of the junction's target key; children of reverse relations
   * connect by their primary key.
   */
  const scalarKey = (
    sourceName: string,
    relation: TableSnapshot["relations"][number],
  ): string | undefined =>
    relation.kind === "through"
      ? referencedName(
          relation.junction,
          relation.targetForeignKey,
          relation.target,
        )
      : relation.kind === "one" && !relation.reverse
        ? referencedName(sourceName, relation.foreignKey, relation.target)
        : undefined;

  const connect = (
    name: string,
    value: unknown,
    scalarColumn?: string,
  ): unknown => {
    const table = tableByName.get(name)!;

    // An object is a key object when its fields are a unique key of the
    // table; anything else is a key value, which the column's codec encodes
    // (a customType() value object) or which binds as it is (a Date for a
    // timestamptz key, a Uint8Array for a bytea one).
    if (
      value &&
      typeof value === "object" &&
      !(COLUMN_EXPRESSION in value) &&
      !keyValueObject(value) &&
      uniqueKeys(table).some(
        (key) =>
          key.length === definedEntries(value).length &&
          key.every(
            (column) =>
              (value as Record<string, unknown>)[column] !== undefined,
          ),
      )
    ) {
      return Object.fromEntries(
        definedEntries(value).map(([column, entry]) => [
          column,
          scalar(name, column, entry),
        ]),
      );
    }

    const primary = primaryKeyColumns(table);

    if (scalarColumn !== undefined) {
      return scalar(name, scalarColumn, value);
    }

    return primary.length === 1
      ? scalar(name, primary[0]!.name, value)
      : copyInput(value);
  };

  const ancestors = new Set<object>();

  const capture = (name: string, value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return copyInput(value);
    }

    if (ancestors.has(value)) {
      throw new Error("symmetria: cyclic nested insert input");
    }

    ancestors.add(value);
    const table = tableByName.get(name)!;
    const result = Object.fromEntries(
      definedEntries(value).map(([field, entry]) => {
        const relation = table.relations.find(
          (relation) => relation.name === field,
        );

        if (relation?.kind === "condition") {
          throw conditionWrite(name, field);
        }

        if (
          !relation ||
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          return [field, scalar(name, field, entry)];
        }

        const operations = Object.fromEntries(
          definedEntries(entry).map(([operation, payload]) => {
            const target = (row: unknown) =>
              operation === "connect"
                ? connect(relation.target, row, scalarKey(name, relation))
                : capture(relation.target, row);

            return [
              operation,
              relation.kind === "one" || !Array.isArray(payload)
                ? target(payload)
                : payload.map(target),
            ];
          }),
        );

        return [field, operations];
      }),
    );
    ancestors.delete(value);

    return freeze(result);
  };

  /**
   * The column values a connect names, as find() reads them. `capture()`
   * has told key objects from key values already: a key value with a codec
   * is an encoded expression, a Date or binary value binds as it is, and an
   * object left is a key object (one that names no unique key fails in find()).
   */
  const lookupFields = (
    name: string,
    selection: unknown,
    scalarColumn?: string,
  ): Record<string, unknown> => {
    const primary = primaryKeyColumns(tableByName.get(name)!);

    return selection !== null &&
      typeof selection === "object" &&
      !(COLUMN_EXPRESSION in selection) &&
      !Array.isArray(selection) &&
      !keyValueObject(selection)
      ? (selection as Record<string, unknown>)
      : scalarColumn !== undefined
        ? { [scalarColumn]: selection }
        : primary.length === 1
          ? { [primary[0]!.name]: selection }
          : {};
  };

  /**
   * A key value as text, for telling lookups of one column apart: the value
   * as it is sent. Undefined for values without a plain form; those are
   * looked up one by one.
   */
  const lookupKey = (value: unknown): string | undefined => {
    const sent =
      value && typeof value === "object" && COLUMN_EXPRESSION in value
        ? (() => {
            const { node } = readColumn(value as never);

            return node.kind === "parameter" ? node.value : undefined;
          })()
        : value;

    if (sent instanceof Date) {
      return `date:${sent.getTime()}`;
    }

    return sent === null || sent === undefined || typeof sent === "object"
      ? undefined
      : `${typeof sent}:${String(sent)}`;
  };

  /**
   * Every row the input connects by one column, by table and column: they are
   * read together before the first write instead of one statement each.
   */
  const connected = (
    rows: readonly Record<string, unknown>[],
  ): Map<string, Map<string, Map<string, unknown>>> => {
    const wanted = new Map<string, Map<string, Map<string, unknown>>>();

    const walk = (name: string, data: unknown): void => {
      const table = tableByName.get(name);

      if (!table || !data || typeof data !== "object" || Array.isArray(data)) {
        return;
      }

      for (const [field, operations] of Object.entries(data)) {
        const relation = table.relations.find((entry) => entry.name === field);

        if (
          !relation ||
          relation.kind === "condition" ||
          !operations ||
          typeof operations !== "object" ||
          Array.isArray(operations)
        ) {
          continue;
        }

        for (const [operation, payload] of Object.entries(operations)) {
          for (const entry of Array.isArray(payload) ? payload : [payload]) {
            if (operation === "create") {
              walk(relation.target, entry);
            }

            if (operation !== "connect") {
              continue;
            }

            const fields = Object.entries(
              lookupFields(relation.target, entry, scalarKey(name, relation)),
            );
            const key =
              fields.length === 1 ? lookupKey(fields[0]![1]) : undefined;

            if (key === undefined) {
              continue;
            }

            let columns = wanted.get(relation.target);

            if (!columns) {
              wanted.set(relation.target, (columns = new Map()));
            }

            let keys = columns.get(fields[0]![0]);

            if (!keys) {
              columns.set(fields[0]![0], (keys = new Map()));
            }

            keys.set(key, fields[0]![1]);
          }
        }
      }
    };

    for (const row of rows) {
      walk(tableName, row);
    }

    return wanted;
  };

  return {
    tableByName,
    referencedName,
    scalarKey,
    capture,
    lookupFields,
    lookupKey,
    connected,
    readsExactly,
    keyShape,
    insertedRow,
    rowShape,
    readRow,
    matchedPosition,
    keyValue,
    primarySortValues,
  };
};
