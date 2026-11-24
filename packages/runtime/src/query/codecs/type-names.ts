/**
 * One spelling for the SQL type names the runtime decides by. PostgreSQL reads
 * `int8`, `BIGINT`, `pg_catalog.int8` and `bigserial` as one type, and
 * `DECIMAL(30, 10)` as `numeric(30,10)`; a `customType()` may be declared with
 * any of them, and behaves as the type it is. Decisions only: DDL and the
 * casts of a declared type keep its spelling, so page cursors do not change.
 * A `base` codec found by another name casts in this spelling (`base: "int8[]"`
 * parameters as `bigint[]`).
 */

/** PostgreSQL's other names for types, as the builders spell them. */
const ALIASES: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    int8: "bigint",
    bigserial: "bigint",
    serial8: "bigint",
    int: "integer",
    int4: "integer",
    serial: "integer",
    serial4: "integer",
    int2: "smallint",
    smallserial: "smallint",
    serial2: "smallint",
    decimal: "numeric",
    dec: "numeric",
    bool: "boolean",
    float4: "real",
    float8: "double precision",
    "character varying": "varchar",
    "char varying": "varchar",
    "bit varying": "varbit",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time without time zone": "time",
    "time with time zone": "timetz",
  },
);

/** Types whose modifiers the runtime keeps: precision, scale, length, dimensions. */
const MODIFIED =
  /^(?:numeric|timestamptz|timestamp|time|timetz|varchar|character|char|bpchar|bit|varbit|vector|halfvec|sparsevec)$/;

/**
 * PostgreSQL's own types and pgvector's, in the runtime's spelling: never a
 * domain, whose name alone does not tell its base type or the precision it
 * rounds to.
 */
const BUILT_IN = new Set([
  "bigint",
  "integer",
  "smallint",
  "real",
  "double precision",
  "numeric",
  "money",
  "text",
  "varchar",
  "char",
  "character",
  "bpchar",
  "name",
  "boolean",
  "bytea",
  "uuid",
  "json",
  "jsonb",
  "jsonpath",
  "xml",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "inet",
  "cidr",
  "macaddr",
  "macaddr8",
  "bit",
  "varbit",
  "tsvector",
  "tsquery",
  "point",
  "line",
  "lseg",
  "box",
  "path",
  "polygon",
  "circle",
  "oid",
  "int4range",
  "int8range",
  "numrange",
  "tsrange",
  "tstzrange",
  "daterange",
  "int4multirange",
  "int8multirange",
  "nummultirange",
  "tsmultirange",
  "tstzmultirange",
  "datemultirange",
  "pg_lsn",
  "vector",
  "halfvec",
  "sparsevec",
]);

const isBuiltIn = (name: string): boolean =>
  BUILT_IN.has(ALIASES[name] ?? name);

/** `[]`, `[3][3]` or the standard ` ARRAY` / ` ARRAY[3]` after the element type. */
const ARRAY_SUFFIX = /(?:\s*\[\s*\d*\s*\])+$|\s+array(?:\s*\[\s*\d*\s*\])?$/i;

const canonicalize = (declared: string): string => {
  let text = declared.trim();
  const suffix = ARRAY_SUFFIX.exec(text);
  let array = suffix
    ? "[]".repeat(Math.max(1, suffix[0].split("[").length - 1))
    : "";

  if (suffix) {
    text = text.slice(0, suffix.index).trimEnd();
  }

  text = text
    .replace(/^pg_catalog\s*\.\s*/i, "")
    .replace(/^"pg_catalog"\s*\.\s*/, "");

  // A quoted name is the type of exactly that name; letter case counts.
  const quoted = /^"((?:[^"]|"")+)"\s*(\(.*\))?$/s.exec(text);
  let typmod = "";
  let name: string;

  if (quoted) {
    name = quoted[1]!.replaceAll('""', '"');
    typmod = quoted[2]?.replace(/\s+/g, "") ?? "";
  } else {
    name = text
      .toLowerCase()
      .replace(/\s*\(([^)]*)\)/, (_match, inner: string) => {
        typmod = `(${inner.replace(/\s+/g, "")})`;

        return "";
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  // `_int8` is PostgreSQL's own name for `int8[]`; a domain's `_amount` keeps its name.
  if (name.startsWith("_") && isBuiltIn(name.slice(1))) {
    name = name.slice(1);
    array = `[]${array}`;
  }

  if (name === "float") {
    // float(1) to float(24) is real; float(25) to float(53) and a bare float
    // are double precision.
    const precision = Number(typmod.slice(1, -1));

    return `${typmod && precision <= 24 ? "real" : "double precision"}${array}`;
  }

  if (name.startsWith("interval")) {
    // `interval day to second(3)`: the fields do not change how values read.
    return `interval${array}`;
  }

  const canonical = ALIASES[name] ?? name;

  return `${canonical}${MODIFIED.test(canonical) ? typmod : ""}${array}`;
};

const known = new Map<string, string>();

/**
 * The runtime's spelling of a SQL type: `int8`, `BIGINT` and `bigserial` are
 * `bigint`, `DECIMAL(30, 10)` and `dec(30,10)` are `numeric(30,10)`, `bool`
 * is `boolean`, `timestamp(3) with time zone` is `timestamptz(3)`, `int8[]`,
 * `_int8` and `int8 ARRAY` are `bigint[]`. Names it does not know are
 * lowercased unless quoted. The builders' own spellings come back unchanged.
 */
export const canonicalType = (sqlType: string): string => {
  let canonical = known.get(sqlType);

  if (canonical === undefined) {
    canonical = canonicalize(sqlType);

    // Type names come from declarations, so the map stays small; bound it anyway.
    if (known.size < 1024) {
      known.set(sqlType, canonical);
    }
  }

  return canonical;
};

/**
 * Whether a type, in the runtime's spelling, is one of PostgreSQL's own or
 * pgvector's (or an array of one): `numeric(30,10)` and `timestamptz(3)[]`
 * are, a domain such as `amount` or another extension's `citext` are not.
 */
export const isBuiltInType = (canonical: string): boolean =>
  BUILT_IN.has(canonical.replace(/(?:\[\])+$/, "").replace(/\(.*\)$/, ""));
