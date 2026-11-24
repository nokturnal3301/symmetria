/**
 * Catalog queries that only introspection needs on top of readCatalog: column
 * declaration order, generated columns, partitioning, structured index details,
 * the domains columns use, and what the schema cannot declare (views,
 * triggers, inheritance, row-level security, routines, sequences, tables of
 * other schemas).
 */
import { normalizeResult } from "symmetria/internal";
import {
  readCatalog,
  readExtensions,
  type CatalogOptions,
} from "../migrations/catalog";

export type ColumnLayoutRow = {
  table_name: string;
  column_name: string;
  position: number;
  /** attgenerated: '' for ordinary columns, 's' for stored generated columns. */
  generated: string;
};

export type TableDetailRow = {
  name: string;
  /** relkind: 'r' ordinary table, 'p' partitioned parent. */
  kind: string;
  partition: boolean;
  /** relpersistence: 'p' logged, 'u' UNLOGGED. */
  persistence?: string;
};

export type IndexDetailRow = {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  nulls_not_distinct: boolean;
  method: string;
  keys: string[];
  /** indoption bits per key: 1 = DESC, 2 = NULLS FIRST. */
  options: number[];
  included: string[];
  /** Non-default operator class per key, null when the default applies. */
  opclasses: (string | null)[];
  /** Operator class per key, the default one included. */
  opclass_names: string[];
  /** Collation per key when it differs from the key's own (a `COLLATE` in the definition), else null. */
  collations: (string | null)[];
  /** Storage parameters as `name=value` strings, or null. */
  reloptions: string[] | null;
  predicate: string | null;
  definition: string;
};

const query = async <Row>(
  options: CatalogOptions,
  sql: string,
): Promise<Row[]> =>
  normalizeResult(
    await options.execute({
      sql,
      parameters: [
        options.schemaName ?? null,
        options.metadataSchema ?? "public",
        options.metadataTable ?? "_symmetria_migrations",
      ],
    }),
  ).rows as Row[];

const filter =
  "namespace.nspname = COALESCE($1, current_schema()) AND NOT (namespace.nspname = $2 AND relation.relname = $3)";

/** Physical column order and generated-column markers; kept apart from readCatalog, whose rows are compared across databases. */
export const readColumnLayout = (options: CatalogOptions) =>
  query<ColumnLayoutRow>(
    options,
    `SELECT relation.relname AS table_name, attribute.attname AS column_name,
      attribute.attnum::integer AS position, attribute.attgenerated::text AS generated
    FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE ${filter} AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY relation.relname COLLATE "C", attribute.attnum`,
  );

export const readTableDetails = (options: CatalogOptions) =>
  query<TableDetailRow>(
    options,
    `SELECT relation.relname AS name, relation.relkind::text AS kind, relation.relispartition AS partition,
      relation.relpersistence::text AS persistence
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE ${filter} AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname COLLATE "C"`,
  );

/** Every non-primary-key index with its keys, ordering flags, INCLUDE columns and predicate. */
export const readIndexDetails = (options: CatalogOptions) =>
  query<IndexDetailRow>(
    options,
    `SELECT relation.relname AS table_name, indexrelation.relname AS index_name,
      index.indisunique AS is_unique, COALESCE((to_jsonb(index)->>'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct, accessmethod.amname AS method,
      ARRAY(SELECT pg_get_indexdef(index.indexrelid, position, true)
        FROM generate_series(1, index.indnkeyatts) position) AS keys,
      ARRAY(SELECT index.indoption[position - 1]::integer
        FROM generate_series(1, index.indnkeyatts) position) AS options,
      ARRAY(SELECT pg_get_indexdef(index.indexrelid, position, true)
        FROM generate_series(index.indnkeyatts + 1, index.indnatts) position) AS included,
      ARRAY(SELECT CASE WHEN opclass.opcdefault THEN NULL ELSE opclass.opcname::text END
        FROM unnest(index.indclass::oid[]) WITH ORDINALITY classes(oid, position)
        JOIN pg_opclass opclass ON opclass.oid = classes.oid ORDER BY position) AS opclasses,
      ARRAY(SELECT opclass.opcname::text
        FROM unnest(index.indclass::oid[]) WITH ORDINALITY classes(oid, position)
        JOIN pg_opclass opclass ON opclass.oid = classes.oid ORDER BY position) AS opclass_names,
      ARRAY(SELECT CASE
          WHEN index.indcollation[position - 1] = 0 THEN NULL
          WHEN index.indkey[position - 1] <> 0 THEN (SELECT CASE WHEN keycolumn.attcollation = index.indcollation[position - 1] THEN NULL ELSE collation_entry.collname::text END
            FROM pg_attribute keycolumn WHERE keycolumn.attrelid = index.indrelid AND keycolumn.attnum = index.indkey[position - 1])
          WHEN strpos(pg_get_indexdef(index.indexrelid, 0, true), pg_get_indexdef(index.indexrelid, position, true) || ' COLLATE ') > 0 THEN collation_entry.collname::text
          ELSE NULL END
        FROM generate_series(1, index.indnkeyatts) position
        LEFT JOIN pg_collation collation_entry ON collation_entry.oid = index.indcollation[position - 1]
        ORDER BY position) AS collations,
      indexrelation.reloptions::text[] AS reloptions,
      pg_get_expr(index.indpred, index.indrelid, true) AS predicate,
      pg_get_indexdef(index.indexrelid) AS definition
    FROM pg_index index
    JOIN pg_class relation ON relation.oid = index.indrelid
    JOIN pg_class indexrelation ON indexrelation.oid = index.indexrelid
    JOIN pg_am accessmethod ON accessmethod.oid = indexrelation.relam
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE ${filter} AND NOT index.indisprimary
    ORDER BY relation.relname COLLATE "C", indexrelation.relname COLLATE "C"`,
  );

/**
 * Objects `pull` cannot declare but must report: views, materialized views,
 * triggers, inheritance children, row-level security and routines.
 */
export type UndeclaredObjectRow = {
  kind:
    | "view"
    | "materialized view"
    | "trigger"
    | "inheritance"
    | "row security"
    | "function";
  name: string;
  /** The table a trigger, inheritance link or policy set belongs to. */
  table_name: string | null;
  /**
   * The view or trigger definition; the parent of an inheritance child; the
   * policy names of a table, one per line, prefixed with `enabled` or
   * `disabled` for its row-security switch; `function` or `procedure`.
   */
  definition: string;
};

const notExtensionMember = (catalog: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend dependency
    WHERE dependency.classid = '${catalog}'::regclass AND dependency.objid = ${oid} AND dependency.deptype = 'e')`;

export const readUndeclaredObjects = (options: CatalogOptions) =>
  query<UndeclaredObjectRow>(
    options,
    `SELECT * FROM (
      SELECT CASE relation.relkind WHEN 'v' THEN 'view' ELSE 'materialized view' END AS kind,
        relation.relname AS name, NULL::name AS table_name,
        pg_get_viewdef(relation.oid, true) AS definition
      FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${filter} AND relation.relkind IN ('v', 'm')
        AND NOT EXISTS (SELECT 1 FROM pg_depend dependency
          WHERE dependency.objid = relation.oid AND dependency.deptype = 'e')
      UNION ALL
      SELECT 'trigger', trigger.tgname, relation.relname, pg_get_triggerdef(trigger.oid, true)
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${filter} AND NOT trigger.tgisinternal
      UNION ALL
      SELECT 'inheritance', relation.relname, relation.relname, parent.relname::text
      FROM pg_inherits inheritance JOIN pg_class relation ON relation.oid = inheritance.inhrelid
      JOIN pg_class parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${filter} AND relation.relkind = 'r' AND NOT relation.relispartition
      UNION ALL
      SELECT 'row security', relation.relname, relation.relname,
        array_to_string(ARRAY[CASE WHEN relation.relrowsecurity THEN 'enabled' ELSE 'disabled' END]
          || ARRAY(SELECT policy.polname::text FROM pg_policy policy
            WHERE policy.polrelid = relation.oid ORDER BY policy.polname COLLATE "C"), chr(10))
      FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${filter} AND relation.relkind IN ('r', 'p')
        AND (relation.relrowsecurity OR EXISTS (SELECT 1 FROM pg_policy policy WHERE policy.polrelid = relation.oid))
      UNION ALL
      SELECT DISTINCT 'function', routine.proname, NULL::name,
        CASE routine.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END
      FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = COALESCE($1, current_schema())
        AND ${notExtensionMember("pg_proc", "routine.oid")}
    ) objects
    ORDER BY kind, name COLLATE "C", table_name COLLATE "C"`,
  );

/** A sequence of the schema, with the column that owns it and how many column defaults draw from it. */
export type SequenceRow = {
  name: string;
  /** The name as a nextval() default prints it: quoted, and qualified outside the search path. */
  reference: string;
  /** Set for a serial or identity column of this schema; null for a standalone sequence. */
  owner_table: string | null;
  owner_column: string | null;
  /** True for the internal sequence of an identity column. */
  identity: boolean;
  defaults: number;
  /** Options other than an identity's defaults (START 1, INCREMENT 1, …), as SQL; empty when none. */
  options?: string;
};

export const readSequences = (options: CatalogOptions) =>
  query<SequenceRow>(
    options,
    `SELECT relation.relname AS name, relation.oid::regclass::text AS reference,
      owner.relname AS owner_table, attribute.attname AS owner_column,
      COALESCE(ownership.deptype = 'i', false) AS identity,
      (SELECT count(*)::integer FROM pg_depend usage
        WHERE usage.classid = 'pg_attrdef'::regclass AND usage.refclassid = 'pg_class'::regclass
          AND usage.refobjid = relation.oid) AS defaults,
      concat_ws(' ',
        CASE WHEN sequence.seqstart <> 1 THEN 'START ' || sequence.seqstart END,
        CASE WHEN sequence.seqincrement <> 1 THEN 'INCREMENT ' || sequence.seqincrement END,
        CASE WHEN sequence.seqmin <> 1 THEN 'MINVALUE ' || sequence.seqmin END,
        CASE WHEN sequence.seqmax <> CASE sequence.seqtypid WHEN 'smallint'::regtype THEN 32767
          WHEN 'integer'::regtype THEN 2147483647 ELSE 9223372036854775807 END
          THEN 'MAXVALUE ' || sequence.seqmax END,
        CASE WHEN sequence.seqcycle THEN 'CYCLE' END) AS options
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_sequence sequence ON sequence.seqrelid = relation.oid
    LEFT JOIN pg_depend ownership ON ownership.classid = 'pg_class'::regclass AND ownership.objid = relation.oid
      AND ownership.refclassid = 'pg_class'::regclass AND ownership.refobjsubid > 0 AND ownership.deptype IN ('a', 'i')
      AND (SELECT owner.relnamespace FROM pg_class owner WHERE owner.oid = ownership.refobjid) = relation.relnamespace
    LEFT JOIN pg_class owner ON owner.oid = ownership.refobjid
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = ownership.refobjid AND attribute.attnum = ownership.refobjsubid
    WHERE ${filter} AND relation.relkind = 'S'
      AND ${notExtensionMember("pg_class", "relation.oid")}
    ORDER BY relation.relname COLLATE "C"`,
  );

/** User tables outside the schema being read, counted per schema. */
export type OtherSchemaRow = { schema: string; tables: number };

export const readOtherSchemas = (options: CatalogOptions) =>
  query<OtherSchemaRow>(
    options,
    `SELECT namespace.nspname AS schema, count(*)::integer AS tables
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> COALESCE($1, current_schema())
      AND NOT (namespace.nspname = $2 AND relation.relname = $3)
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_(toast|temp)'
      AND relation.relkind IN ('r', 'p') AND NOT relation.relispartition
      AND relation.relpersistence <> 't'
      AND ${notExtensionMember("pg_class", "relation.oid")}
    GROUP BY namespace.nspname
    ORDER BY namespace.nspname COLLATE "C"`,
  );

/** A domain type: its name as columns spell it and the type it is based on (a domain too, sometimes). */
export type DomainRow = { name: string; base: string };

/**
 * Every domain, named as format_type() names it in a column's type, with its
 * base type and modifiers (`numeric(30,10)`). Domains of every schema: a
 * table may use one from another schema.
 */
export const readDomains = (options: CatalogOptions) =>
  query<DomainRow>(
    options,
    `SELECT format_type(type.oid, NULL) AS name, format_type(type.typbasetype, type.typtypmod) AS base
    FROM pg_type type
    WHERE type.typtype = 'd'
      -- The shared parameters are not needed here, but must be referenced.
      AND num_nulls($1::text, $2::text, $3::text) >= 0
    ORDER BY format_type(type.oid, NULL) COLLATE "C"`,
  );

export type PullCatalog = Awaited<ReturnType<typeof readCatalog>> & {
  schemaName: string;
  /** Tables of the schema left out through `ignoreTables`. */
  ignored?: string[];
  layout: ColumnLayoutRow[];
  details: TableDetailRow[];
  indexDetails: IndexDetailRow[];
  extensions: { name: string; schema: string }[];
  undeclared: UndeclaredObjectRow[];
  sequences: SequenceRow[];
  otherSchemas: OtherSchemaRow[];
  /** Domain types and their base types; absent in catalogs built by hand. */
  domains?: DomainRow[];
};

/**
 * Everything `pull` needs in one round of queries. Tables in `ignoreTables`
 * are left out with their columns, constraints, indexes and triggers, and so
 * are enum types only they use; foreign keys of other tables that point to
 * them stay in, for the model to report.
 */
export const readPullCatalog = async (
  options: CatalogOptions,
): Promise<PullCatalog> => {
  const [schemaRow] = await query<{ name: string }>(
    options,
    "SELECT COALESCE($1, current_schema()) AS name WHERE $2::text IS NOT NULL AND $3::text IS NOT NULL",
  );
  const catalog = await readCatalog({ ...options, ignoreTables: [] });
  const layout = await readColumnLayout(options);
  const details = await readTableDetails(options);
  const indexDetails = await readIndexDetails(options);
  const extensions = await readExtensions(options);
  const undeclared = await readUndeclaredObjects(options);
  const sequences = await readSequences(options);
  const otherSchemas = await readOtherSchemas(options);
  const domains = await readDomains(options);
  const ignoreTables = new Set(options.ignoreTables ?? []);

  const kept = <Row extends { table_name?: string | null; name?: string }>(
    rows: Row[],
  ): Row[] =>
    rows.filter((row) => !ignoreTables.has(row.table_name ?? row.name ?? ""));

  const columns = kept(catalog.columns);
  const ignoredEnumerations = new Set(
    catalog.columns
      .filter(
        (column) =>
          column.enum_name &&
          ignoreTables.has(column.table_name) &&
          !columns.some((entry) => entry.enum_name === column.enum_name),
      )
      .map((column) => column.enum_name),
  );

  return {
    tables: kept(catalog.tables),
    columns,
    constraints: kept(catalog.constraints),
    indexes: kept(catalog.indexes),
    enumerations: catalog.enumerations.filter(
      (enumeration) => !ignoredEnumerations.has(enumeration.name),
    ),
    schemaName: schemaRow?.name ?? options.schemaName ?? "public",
    ignored: catalog.tables
      .filter((table) => ignoreTables.has(table.name))
      .map((table) => table.name),
    layout: kept(layout),
    details: kept(details),
    indexDetails: kept(indexDetails),
    extensions,
    // A routine is not a table's: one named like an ignored table stays listed.
    undeclared: undeclared.filter(
      (row) =>
        row.kind === "function" ||
        !ignoreTables.has(row.table_name ?? row.name),
    ),
    sequences,
    otherSchemas,
    domains,
  };
};
