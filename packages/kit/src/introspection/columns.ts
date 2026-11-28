import { sqlKey } from "symmetria";
import { normalizeSqlType } from "../migrations/drift";
import { expressionKey } from "../migrations/expressions";
import {
  conventionalNames,
  isReservedColumnKey,
  quoteString,
  sqlString,
} from "./names";
import type {
  PullWarning,
  ColumnType,
  ColumnDefault,
  PulledColumn,
  PulledSearch,
} from "./pulled";
import {
  type CatalogColumn,
  type TableFacts,
  customValueType,
  domainValueType,
  serialFix,
} from "./model";

export type ColumnTools = {
  ownsEnum: (column: CatalogColumn) => boolean;
  enumValues: (name: string) => string[] | undefined;
  /** A domain's base type (the innermost one for a domain over a domain), else undefined. */
  domainBase: (name: string) => string | undefined;
  serialSequence: (
    column: CatalogColumn,
    reference: string,
  ) => { exclusive: boolean; reason: string };
  warn: (warning: PullWarning) => void;
  uniqueFor: (columnName: string) => { unique: boolean; comments: string[] };
  indexFor: (columnName: string, unique: boolean) => boolean;
};

/** One `setweight(to_tsvector(…, COALESCE(column, '')), 'W')` of a stored document, as PostgreSQL prints it. */
const DOCUMENT_PART =
  /setweight\(to_tsvector\('((?:[^']|'')*)'(?:::regconfig)?, \(?COALESCE\(("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*), ''::[a-z ]+\)(?:\)::text)?\), '([ABCD])'::"char"\)/g;

const unquote = (identifier: string): string =>
  identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;

/**
 * The full-text search whose document `column` stores: a generated tsvector
 * column keyed `<search>Words`, computed exactly as `fullText()` computes it
 * from the table's own text columns, with the GIN index `.search()` creates
 * under its conventional name. Undefined for any other generated column,
 * which stays a plain column with a warning.
 */
export const fullTextSearch = (
  column: CatalogColumn,
  key: string,
  table: TableFacts,
): (PulledSearch & { index: string }) | undefined => {
  if (
    !table.generated.has(column.column_name) ||
    // `.search()` creates the column nullable; a NOT NULL one stays a column.
    column.not_null ||
    normalizeSqlType(column.data_type) !== "tsvector" ||
    !column.default ||
    !/^[a-z][A-Za-z0-9]*Words$/.test(key) ||
    // `.search()` names the column after the key, without `.named()`.
    sqlKey(key, table.casing) !== column.column_name
  ) {
    return undefined;
  }

  const found = [...column.default.matchAll(DOCUMENT_PART)].map((match) => ({
    language: match[1]!.replaceAll("''", "'"),
    column: unquote(match[2]!),
    weight: match[3] as PulledSearch["parts"][number]["weight"],
  }));
  const language = found[0]?.language;
  const sources = found.map((part) =>
    table.columns.find((entry) => entry.column_name === part.column),
  );

  if (
    language === undefined ||
    found.some((part) => part.language !== language) ||
    sources.some(
      (source) =>
        !source ||
        table.generated.has(source.column_name) ||
        table.references.has(source.column_name) ||
        source.enum_name !== null ||
        !/^(?:text|character varying(?:\(\d+\))?)$/.test(
          normalizeSqlType(source.data_type),
        ),
    )
  ) {
    return undefined;
  }

  // fullText() writes the parts by weight, A first; PostgreSQL adds the cast
  // to text a varchar column needs.
  const parts = (["A", "B", "C", "D"] as const).flatMap((weight) =>
    found.flatMap((part, position) =>
      part.weight === weight ? [{ part, source: sources[position]! }] : [],
    ),
  );
  const expected = parts
    .map(({ part, source }) => {
      const value = `coalesce("${part.column.replaceAll('"', '""')}", '')`;

      return `setweight(to_tsvector(${sqlString(language)}, ${normalizeSqlType(source.data_type) === "text" ? value : `(${value})::text`}), '${part.weight}')`;
    })
    .join(" || ");
  const types = new Map(
    table.columns.map((entry) => [entry.column_name, entry.data_type]),
  );
  const same = (() => {
    try {
      return (
        expressionKey(column.default, types) === expressionKey(expected, types)
      );
    } catch {
      return false;
    }
  })();
  // `.search()` declares the index under the column's key.
  const index = conventionalNames.index(table.sqlName, key, table.casing);
  const indexed = table.indexes.some(
    (entry) =>
      entry.index_name === index &&
      entry.method === "gin" &&
      !entry.is_unique &&
      entry.keys.length === 1 &&
      unquote(entry.keys[0]!) === column.column_name &&
      entry.predicate === null &&
      entry.included.length === 0 &&
      entry.options.every((option) => option === 0) &&
      entry.opclasses.every((opclass) => opclass === null) &&
      !entry.reloptions?.length,
  );

  // Another index or a constraint on the column would lose its column: the
  // search declares it hidden, so the column stays (with its warning).
  const named = new RegExp(
    `(?:^|[^\\w$"])(?:${column.column_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|"${column.column_name.replaceAll('"', '""').replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")(?![\\w$"])`,
  );
  const used =
    table.indexes.some(
      (entry) =>
        entry.index_name !== index &&
        [...entry.keys, ...entry.included, entry.predicate ?? ""].some((part) =>
          named.test(part),
        ),
    ) ||
    table.constraints.some((entry) =>
      entry.columns.includes(column.column_name),
    );

  if (!same || !indexed || used) {
    return undefined;
  }

  const members = new Map(
    [...table.columnKeys].map(([sqlName, member]) => [sqlName, member]),
  );

  return {
    key: key.slice(0, -"Words".length),
    language,
    parts: parts.map(({ part }) => ({
      weight: part.weight,
      member: members.get(part.column)!,
    })),
    index,
  };
};

export const columnMember = (
  column: CatalogColumn,
  key: string,
  table: TableFacts,
  tools: ColumnTools,
): PulledColumn => {
  const comments: string[] = [];
  const { unique, comments: uniqueComments } = tools.uniqueFor(
    column.column_name,
  );
  comments.push(...uniqueComments);
  const { type, array } = columnType(column, table, tools, comments);
  const member: PulledColumn = {
    kind: "column",
    key,
    sqlName: column.column_name,
    type,
    array,
    nullable: !column.not_null,
    unique,
    index: tools.indexFor(column.column_name, unique),
    primaryKey: false,
    comments,
  };

  if (column.collation) {
    const collatable =
      (type.kind === "builder" && type.name === "text") ||
      type.kind === "varchar" ||
      (type.kind === "custom" && /^string(\[\])?$/.test(type.valueType));

    if (collatable) {
      member.collation = column.collation;
    } else {
      comments.push(`collation "${column.collation}" is not declared`);
      tools.warn({
        code: "collation",
        table: table.sqlName,
        column: column.column_name,
        object: column.collation,
        message: `"${table.sqlName}.${column.column_name}" uses collation "${column.collation}", which the schema cannot declare for ${column.data_type}`,
      });
    }
  }

  if (isReservedColumnKey(key)) {
    comments.push(
      `"${key}" is also a table method; use it inside shape callbacks`,
    );
    tools.warn({
      code: "name",
      table: table.sqlName,
      column: column.column_name,
      message: `"${table.sqlName}.${column.column_name}" shares its key with a table method; reach it inside shape callbacks`,
    });
  }

  if (table.generated.has(column.column_name)) {
    comments.push("generated column; the expression is not declared");
    tools.warn({
      code: "generated-column",
      table: table.sqlName,
      column: column.column_name,
      message: `"${table.sqlName}.${column.column_name}" is a generated column; the schema declares a plain column`,
    });

    return member;
  }

  const value = columnDefault(column, type, array, table, tools, comments);

  if (value) {
    member.default = value;
  }

  return member;
};

export const columnType = (
  column: CatalogColumn,
  table: TableFacts,
  tools: ColumnTools,
  comments: string[],
): { type: ColumnType; array: boolean } => {
  const normalized = normalizeSqlType(column.data_type);
  const array = normalized.endsWith("[]") && !normalized.endsWith("[][]");
  const base = array ? normalized.slice(0, -2) : normalized;

  if (column.enum_name && column.enum_schema === null && !array) {
    const values = tools.enumValues(column.enum_name);

    if (values) {
      return {
        type: {
          kind: "enum",
          values,
          ...(tools.ownsEnum(column) ? {} : { name: column.enum_name }),
        },
        array: false,
      };
    }
  }

  const builder = (
    {
      integer: "int",
      bigint: "bigint",
      smallint: "smallint",
      real: "real",
      "double precision": "doublePrecision",
      text: "text",
      boolean: "bool",
      uuid: "uuid",
      "timestamp with time zone": "timestamptz",
      date: "date",
      "time without time zone": "time",
      interval: "interval",
      bytea: "bytea",
      inet: "inet",
      jsonb: "jsonb",
      tsvector: "tsvector",
    } as const
  )[base];

  if (builder) {
    return { type: { kind: "builder", name: builder }, array };
  }

  const stamp = /^timestamp (with|without) time zone(?:\((\d)\))?$/.exec(base);

  if (stamp) {
    return {
      type: {
        kind: "builder",
        name: stamp[1] === "with" ? "timestamptz" : "timestamp",
        ...(stamp[2] ? { precision: Number(stamp[2]) } : {}),
      },
      array,
    };
  }

  const vectorType = /^(vector|halfvec)(?:\((\d+)\))?$/.exec(base);

  if (vectorType && !array) {
    return {
      type: {
        kind: "vector",
        ...(vectorType[1] === "halfvec" ? { half: true as const } : {}),
        ...(vectorType[2] ? { dimensions: Number(vectorType[2]) } : {}),
      },
      array: false,
    };
  }

  const varchar = /^character varying(?:\((\d+)\))?$/.exec(base);

  if (varchar) {
    return {
      type: {
        kind: "varchar",
        ...(varchar[1] ? { length: Number(varchar[1]) } : {}),
      },
      array,
    };
  }

  const numeric = /^numeric(?:\((\d+)(?:,(-?\d+))?\))?$/.exec(base);

  if (numeric) {
    const scale = Number(numeric[2] ?? 0);

    if (scale >= 0 && scale <= Number(numeric[1] ?? 0)) {
      return {
        type: {
          kind: "numeric",
          ...(numeric[1] ? { precision: Number(numeric[1]) } : {}),
          ...(numeric[2] ? { scale } : {}),
        },
        array,
      };
    }

    // numeric() takes a scale from zero to the precision. PostgreSQL 15 and
    // later also allow one above it (`numeric(3,5)`: values below 0.001) or
    // below zero (`numeric(5,-2)`). Such a column keeps its type through
    // customType() and the values of numeric, exact decimal text, so it
    // compares and computes with numeric() columns.
    const sqlType = array
      ? column.data_type.replace(/\[\]$/, "")
      : column.data_type;

    comments.push(`no builder for ${sqlType}`);
    tools.warn({
      code: "custom-type",
      table: table.sqlName,
      column: column.column_name,
      object: sqlType,
      message: `"${table.sqlName}.${column.column_name}" uses ${sqlType}, whose scale numeric() does not take; it is declared through customType() with the values of numeric, exact decimal text`,
    });

    return {
      type: {
        kind: "custom",
        sqlType,
        valueType: "Decimal",
        base: "numeric",
      },
      array,
    };
  }

  // Enums of other schemas and arrays of enums have no oneOf() form either.
  // A one-dimensional array is the element type's `.array`, whose codec
  // reads the array however the driver delivers it.
  const sqlType = array
    ? column.data_type.replace(/\[\]$/, "")
    : column.data_type;
  // A domain reads like its base type: PostgreSQL sends its values under the
  // base type's OID, so a domain over bigint delivers bigints.
  const domain = normalized.endsWith("[]") && !array ? undefined : sqlType;
  const domainType =
    domain === undefined ? undefined : tools.domainBase(domain);
  const domainValue =
    domainType === undefined ? undefined : domainValueType(domainType);

  if (domainType !== undefined && domainValue !== undefined) {
    comments.push(`domain over ${domainType}`);
    tools.warn({
      code: "custom-type",
      table: table.sqlName,
      column: column.column_name,
      object: sqlType,
      message: `"${table.sqlName}.${column.column_name}" uses domain ${sqlType} over ${domainType}, declared through customType() with the base type's values; migrations do not create the domain`,
    });

    return {
      type: {
        kind: "custom",
        sqlType,
        valueType: domainValue,
        base: domainType,
      },
      array,
    };
  }

  // A domain over a type without a builder (json, oid, money) is declared
  // like a column of that type: its values are the base type's.
  const native =
    domainType === undefined ? undefined : normalizeSqlType(domainType);
  const nativeElement = native?.replace(/(?:\[\])+$/, "");
  const valueType =
    native === undefined || nativeElement === undefined
      ? customValueType(base) +
        (normalized.endsWith("[]") && !array ? "[]" : "")
      : customValueType(nativeElement.replace(/\(.*\)$/, "")) +
        native.slice(nativeElement.length);
  comments.push(
    domainType === undefined
      ? `no builder for ${sqlType}`
      : `domain over ${domainType}, no builder for it`,
  );
  tools.warn({
    code: "custom-type",
    table: table.sqlName,
    column: column.column_name,
    object: sqlType,
    message:
      domainType === undefined
        ? `"${table.sqlName}.${column.column_name}" uses ${sqlType}, declared through customType() with driver-native values`
        : `"${table.sqlName}.${column.column_name}" uses domain ${sqlType} over ${domainType}, declared through customType() with driver-native values; migrations do not create the domain`,
  });

  return {
    type: {
      kind: "custom",
      sqlType,
      valueType,
    },
    array,
  };
};

export const columnDefault = (
  column: CatalogColumn,
  type: ColumnType,
  array: boolean,
  table: TableFacts,
  tools: ColumnTools,
  comments: string[],
): ColumnDefault | undefined => {
  const name = `${table.sqlName}.${column.column_name}`;
  const integer =
    type.kind === "builder" &&
    (type.name === "int" ||
      type.name === "bigint" ||
      type.name === "smallint") &&
    !array;

  if (column.identity !== "") {
    if (integer) {
      return column.identity === "d"
        ? { kind: "auto", byDefault: true }
        : { kind: "auto" };
    }

    comments.push("identity column");
    tools.warn({
      code: "identity-type",
      table: table.sqlName,
      column: column.column_name,
      message: `"${name}" is an identity column of type ${column.data_type}; it is declared through a raw identity default`,
    });

    return { kind: "identity" };
  }

  const text = column.default;

  if (text === null) {
    return undefined;
  }

  if (!array && type.kind === "builder") {
    if (
      (type.name === "timestamptz" || type.name === "timestamp") &&
      text === "now()"
    ) {
      return { kind: "now" };
    }

    if (type.name === "uuid" && text === "gen_random_uuid()") {
      return { kind: "v4" };
    }

    if (type.name === "uuid" && text === "uuidv7()") {
      return { kind: "v7" };
    }
  }

  const serial = /^nextval\('((?:[^']|'')*)'::regclass\)$/.exec(text);

  if (serial) {
    const sequence = unescapeLiteral(serial[1]!);
    const { exclusive, reason } = tools.serialSequence(column, sequence);

    // Dropping a sequence other columns draw from would break their defaults.
    if (!exclusive) {
      comments.push(
        "default from a shared sequence; migrations will not create the sequence",
      );
      tools.warn({
        code: "sequence",
        table: table.sqlName,
        column: column.column_name,
        object: sequence,
        message: `"${name}" takes its default from sequence ${sequence}, which ${reason}; the schema keeps the nextval() default but migrations from this schema will not create the sequence, and no identity fix is offered because it would drop a sequence something else may use`,
      });

      return { kind: "sql", sql: text };
    }

    comments.push("serial column; migrations will not create the sequence");
    tools.warn({
      code: "serial",
      table: table.sqlName,
      column: column.column_name,
      message: integer
        ? `"${name}" is a serial column; the schema keeps its nextval() default but migrations from this schema will not create the sequence. The fix makes it an identity column (.auto.byDefault) that continues the sequence`
        : `"${name}" is a serial column; the schema keeps its nextval() default but migrations from this schema will not create the sequence`,
      ...(integer
        ? { fix: serialFix(table.sqlName, column.column_name, sequence) }
        : {}),
    });

    return { kind: "sql", sql: text };
  }

  const literal = !array ? literalDefault(text, type) : undefined;

  return literal
    ? { kind: "value", source: literal }
    : { kind: "sql", sql: text };
};

export const unescapeLiteral = (text: string) => text.replaceAll("''", "'");

/**
 * The text a quoted literal of `type` gives a text or varchar column, which
 * is not always the text between the quotes. PostgreSQL drops the trailing
 * spaces of a `bpchar` value when it becomes text (a default of
 * `'ab '::bpchar` stores `ab`), and a cast to `character varying(n)` keeps
 * the first n characters (`'abcdef'::character varying(3)` stores `abc`).
 */
const textValue = (literal: string, type: string): string => {
  const value = unescapeLiteral(literal);

  if (type === "bpchar") {
    return value.replace(/ +$/, "");
  }

  const length = /^character varying\((\d+)\)$/.exec(type)?.[1];

  // PostgreSQL counts characters, not UTF-16 code units.
  return length === undefined
    ? value
    : Array.from(value).slice(0, Number(length)).join("");
};

/** JavaScript source for defaults PostgreSQL prints as simple literals. */
export const literalDefault = (
  text: string,
  type: ColumnType,
): string | undefined => {
  const quoted = /^'((?:[^']|'')*)'::(.+)$/.exec(text);
  const integer =
    /^(-?\d+)$/.exec(text) ??
    /^'(-?\d+)'::(integer|bigint|smallint)$/.exec(text);

  const decimal =
    /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
    /^'(-?\d+(?:\.\d+)?)'::(real|double precision|integer|numeric)$/.exec(text);

  switch (type.kind) {
    case "builder":
      switch (type.name) {
        case "int":
        case "smallint":
          return integer ? integer[1] : undefined;
        case "bigint":
          return integer ? `${integer[1]}n` : undefined;
        case "real":
          return decimal ? decimal[1] : undefined;
        case "doublePrecision":
          // A real literal reaches the column as the nearest real number,
          // which is not the number its text reads as (`'0.1'::real` is
          // 0.10000000149011612): it stays SQL unless both are one number.
          return decimal &&
            (decimal[2] !== "real" ||
              Math.fround(Number(decimal[1])) === Number(decimal[1]))
            ? decimal[1]
            : undefined;
        case "date":
          return quoted && quoted[2] === "date"
            ? quoteString(unescapeLiteral(quoted[1]!))
            : undefined;
        case "time":
          return quoted && quoted[2] === "time without time zone"
            ? quoteString(unescapeLiteral(quoted[1]!))
            : undefined;
        case "interval":
          return quoted && quoted[2] === "interval"
            ? quoteString(unescapeLiteral(quoted[1]!))
            : undefined;
        case "inet":
          return quoted && quoted[2] === "inet"
            ? quoteString(unescapeLiteral(quoted[1]!))
            : undefined;
        case "bool":
          return text === "true" || text === "false" ? text : undefined;
        case "text":
        case "uuid":
          return quoted &&
            /^(text|character varying(\(\d+\))?|uuid|bpchar)$/.test(quoted[2]!)
            ? quoteString(textValue(quoted[1]!, quoted[2]!))
            : undefined;
        case "jsonb":
          return quoted &&
            quoted[2] === "jsonb" &&
            /^(\{\}|\[\])$/.test(quoted[1]!)
            ? quoted[1]
            : undefined;
        default:
          return undefined;
      }
    case "varchar":
      return quoted &&
        /^(text|character varying(\(\d+\))?|bpchar)$/.test(quoted[2]!)
        ? quoteString(textValue(quoted[1]!, quoted[2]!))
        : undefined;
    case "numeric": {
      const decimal =
        /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
        /^'(-?\d+(?:\.\d+)?)'::numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(text);

      if (!decimal) {
        return undefined;
      }

      const digits = decimal[1]!;

      if (decimal[2] === undefined) {
        return quoteString(digits);
      }

      // A literal cast to numeric(p,s) becomes a number of exactly s
      // decimals, which is what a fresh row holds: `'7'::numeric(10,2)` is
      // 7.00, so the zeros are written out. With more decimals than s the
      // cast rounds (`'1.005'::numeric(10,2)` is 1.01), and with more digits
      // than p it fails: such a default stays SQL.
      const scale = Number(decimal[3] ?? 0);
      const [whole = "", fraction = ""] = digits.replace(/^-/, "").split(".");

      if (
        fraction.length > scale ||
        whole.replace(/^0+/, "").length > Number(decimal[2]) - scale
      ) {
        return undefined;
      }

      return quoteString(
        scale === 0
          ? digits
          : `${digits.split(".")[0]}.${fraction.padEnd(scale, "0")}`,
      );
    }
    case "enum":
      return quoted && type.values.includes(unescapeLiteral(quoted[1]!))
        ? quoteString(unescapeLiteral(quoted[1]!))
        : undefined;
    case "custom": {
      if (type.valueType === "number") {
        const number =
          /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
          /^'(-?\d+(?:\.\d+)?)'::\w+( \w+)?$/.exec(text);

        return number ? number[1] : undefined;
      }

      if (type.valueType.startsWith('"') && quoted) {
        const value = quoteString(unescapeLiteral(quoted[1]!));

        return type.valueType.split(" | ").includes(value) ? value : undefined;
      }

      return undefined;
    }
  }
};
