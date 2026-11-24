/**
 * What `pull` reads a database into before it is rendered: tables, columns,
 * references, indexes, checks and the warnings for what cannot be declared.
 */
import type { Casing } from "symmetria";

export type PullWarningCode =
  /**
   * Never reported: BY DEFAULT identities are declared with `.auto.byDefault`.
   * The code stays so that programs that match on it still compile.
   */
  | "identity-by-default"
  | "serial"
  | "identity-type"
  | "generated-column"
  | "custom-type"
  | "collation"
  | "constraint-name"
  | "foreign-key"
  | "unique-constraint"
  | "unique-index"
  | "view"
  | "trigger"
  | "migration-table"
  | "index"
  | "junction-index"
  | "check"
  | "enum"
  | "primary-key"
  | "name"
  | "partition"
  | "unlogged"
  | "exclusion"
  | "extension"
  | "inheritance"
  | "row-security"
  | "function"
  | "sequence"
  | "other-schema";

export type PullWarning = {
  readonly code: PullWarningCode;
  readonly table?: string;
  readonly column?: string;
  /** The constraint, index or type the warning is about. */
  readonly object?: string;
  readonly message: string;
  /** SQL that makes the database match what the generated schema declares. */
  readonly fix?: string;
};

export type ColumnType =
  | {
      kind: "builder";
      name:
        | "int"
        | "bigint"
        | "smallint"
        | "real"
        | "doublePrecision"
        | "text"
        | "bool"
        | "uuid"
        | "timestamptz"
        | "timestamp"
        | "date"
        | "time"
        | "interval"
        | "bytea"
        | "inet"
        | "jsonb"
        | "tsvector";
      /** Fractional-second precision of timestamp builders, `timestamp(3)`. */
      precision?: number;
    }
  | { kind: "varchar"; length?: number }
  | { kind: "numeric"; precision?: number; scale?: number }
  /** `oneOf(...)`; `name` is set when the type is not `<table>_<column>_enum` or is shared. */
  | { kind: "enum"; values: string[]; name?: string }
  /** `vector(n)`, or `halfvec(n)` when `half`. */
  | { kind: "vector"; dimensions?: number; half?: true }
  /**
   * `customType()`. `base` is a domain's base type (`numeric(30,10)`), whose
   * builder the values read and write like; without it, driver-native values.
   */
  | { kind: "custom"; sqlType: string; valueType: string; base?: string };

export type ColumnDefault =
  | { kind: "auto"; byDefault?: true }
  | { kind: "now" }
  | { kind: "v4" }
  | { kind: "v7" }
  | { kind: "identity" }
  | { kind: "value"; source: string }
  | { kind: "sql"; sql: string };

export type PulledColumn = {
  kind: "column";
  key: string;
  sqlName: string;
  type: ColumnType;
  array: boolean;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  primaryKey: boolean;
  default?: ColumnDefault;
  /** Non-default collation, declared with `.collate()`. */
  collation?: string;
  comments: string[];
};

export type PulledReference = {
  kind: "reference";
  key: string;
  sqlName: string;
  /** Key of the referenced table; the generated code names it by that table's binding. */
  target: string;
  /** Key of the referenced column when it is a unique column rather than the primary key. */
  by?: string;
  /** The SQL column name when it is not `<key>_id`. */
  column?: string;
  nullable: boolean;
  unique: boolean;
  index: boolean;
  onDelete?: "cascade" | "setNull" | "noAction";
  onUpdate?: "cascade" | "restrict";
  inverse?: string;
  comments: string[];
};

export type PulledMember = PulledColumn | PulledReference;

export type IndexKeySource = {
  /**
   * `column` keys name a scope member; `value` keys hold DSL source such as
   * `users.score.plus(1)`; `expression` keys hold template text with
   * `${table.column}` interpolations.
   */
  kind: "column" | "value" | "expression";
  source: string;
  descending: boolean;
  nulls?: "first" | "last";
  /** Non-default operator class, rendered through operatorClass(). */
  opclass?: string;
};

export type PulledIndex = {
  /** Object key in the indexes callback; the exact SQL name for schema-level indexes. */
  key: string;
  keys: IndexKeySource[];
  unique: boolean;
  method: string;
  /** Scope member keys. */
  include: string[];
  where?: PulledCondition;
  /** Storage parameters from pg_class.reloptions. */
  with?: Record<string, string | number>;
  comments: string[];
};

/**
 * A CHECK or WHERE condition: a DSL predicate such as `users.score.above(0)`
 * with the functions it imports, or `sql` template text, already interpolated
 * and escaped, for conditions the DSL cannot express.
 */
export type PulledCondition =
  | { kind: "predicate"; source: string; imports: readonly string[] }
  | { kind: "sql"; template: string };

export type PulledCheck = {
  key: string;
  condition: PulledCondition;
  comments: string[];
};

/**
 * A full-text search Symmetria declared with `.search()`: its stored
 * document column (`<key>Words`, generated) and GIN index, read back as the
 * declaration that creates them.
 */
export type PulledSearch = {
  /** The search's key in `.search()`. */
  key: string;
  /** Text search configuration; "simple" is the default. */
  language: string;
  /** Member keys of the text columns in document order, with their weights. */
  parts: { weight: "A" | "B" | "C" | "D"; member: string }[];
};

export type PulledTable = {
  key: string;
  /**
   * The identifier that names the table in generated callbacks: the key, unless
   * the key would shadow an import (`date`, `text`, `sql`) or is a reserved word.
   */
  binding: string;
  sqlName: string;
  junction: boolean;
  members: PulledMember[];
  /** Member keys of an explicit primary key callback (composite keys and keys over relations). */
  primaryKey?: string[];
  indexes: PulledIndex[];
  checks: PulledCheck[];
  /** Full-text searches whose column and index the declaration creates. */
  searches?: PulledSearch[];
  comments: string[];
  skipped: { sqlName: string; dataType: string; reason: string }[];
};

export type PulledSchema = {
  schemaName: string;
  /** The naming rule that lets most tables and columns be declared without `.named()`. */
  casing: Casing;
  tables: PulledTable[];
  /** Indexes whose SQL names do not follow `<table>_<key>_idx`, declared with their exact names. */
  schemaIndexes: { table: string; binding: string; index: PulledIndex }[];
  /** Enum types the schema declares with oneOf(). */
  enumerations: string[];
  /** Installed extensions other than plpgsql, declared through the schema options. */
  extensions: string[];
  skippedTables: { sqlName: string; reason: string }[];
  warnings: PullWarning[];
};
