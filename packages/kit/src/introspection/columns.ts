import { normalizeSqlType } from "../migrations/drift";
import { isReservedColumnKey } from "./names";
import type {
  PullWarning,
  ColumnType,
  ColumnDefault,
  PulledColumn,
} from "./pulled";
import {
  type CatalogColumn,
  type TableFacts,
  customValueType,
  serialFix,
} from "./model";

export type ColumnTools = {
  ownsEnum: (column: CatalogColumn) => boolean;
  enumValues: (name: string) => string[] | undefined;
  serialSequence: (
    column: CatalogColumn,
    reference: string,
  ) => { exclusive: boolean; reason: string };
  warn: (warning: PullWarning) => void;
  uniqueFor: (columnName: string) => { unique: boolean; comments: string[] };
  indexFor: (columnName: string, unique: boolean) => boolean;
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

  const vectorType = /^vector(?:\((\d+)\))?$/.exec(base);

  if (vectorType && !array) {
    return {
      type: {
        kind: "vector",
        ...(vectorType[1] ? { dimensions: Number(vectorType[1]) } : {}),
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

  const numeric = /^numeric(?:\((\d+)(?:,(\d+))?\))?$/.exec(base);

  if (numeric) {
    return {
      type: {
        kind: "numeric",
        ...(numeric[1] ? { precision: Number(numeric[1]) } : {}),
        ...(numeric[2] ? { scale: Number(numeric[2]) } : {}),
      },
      array,
    };
  }

  // Enums of other schemas and arrays of enums have no oneOf() form either.
  const sqlType = column.data_type;
  const valueType =
    customValueType(base) + (normalized.endsWith("[]") ? "[]" : "");
  comments.push(`no builder for ${sqlType}`);
  tools.warn({
    code: "custom-type",
    table: table.sqlName,
    column: column.column_name,
    object: sqlType,
    message: `"${table.sqlName}.${column.column_name}" uses ${sqlType}, declared through customType() with driver-native values`,
  });

  return { type: { kind: "custom", sqlType, valueType }, array: false };
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
        case "doublePrecision":
          return decimal ? decimal[1] : undefined;
        case "date":
          return quoted && quoted[2] === "date"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "time":
          return quoted && quoted[2] === "time without time zone"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "interval":
          return quoted && quoted[2] === "interval"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "inet":
          return quoted && quoted[2] === "inet"
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
            : undefined;
        case "bool":
          return text === "true" || text === "false" ? text : undefined;
        case "text":
        case "uuid":
          return quoted &&
            /^(text|character varying(\(\d+\))?|uuid|bpchar)$/.test(quoted[2]!)
            ? JSON.stringify(unescapeLiteral(quoted[1]!))
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
        ? JSON.stringify(unescapeLiteral(quoted[1]!))
        : undefined;
    case "numeric": {
      const decimal =
        /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
        /^'(-?\d+(?:\.\d+)?)'::numeric(\(\d+(,\d+)?\))?$/.exec(text);

      return decimal ? JSON.stringify(decimal[1]) : undefined;
    }
    case "enum":
      return quoted && type.values.includes(unescapeLiteral(quoted[1]!))
        ? JSON.stringify(unescapeLiteral(quoted[1]!))
        : undefined;
    case "custom": {
      if (type.valueType === "number") {
        const number =
          /^(-?\d+(?:\.\d+)?)$/.exec(text) ??
          /^'(-?\d+(?:\.\d+)?)'::\w+( \w+)?$/.exec(text);

        return number ? number[1] : undefined;
      }

      if (type.valueType.startsWith('"') && quoted) {
        const value = JSON.stringify(unescapeLiteral(quoted[1]!));

        return type.valueType.split(" | ").includes(value) ? value : undefined;
      }

      return undefined;
    }
  }
};
