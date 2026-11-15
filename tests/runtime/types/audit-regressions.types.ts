import { text, int, bool, jsonb, sql } from "../../../packages/runtime/src";

text.nullable.default(null);
int.nullable.default(null);
bool.nullable.default(null);
jsonb<{ value: number }>().nullable.default(null);
// @ts-expect-error non-nullable text cannot default to SQL NULL
text.default(null);
// A raw SQL default is a sql template, not an object that looks like one.
text.default(sql`'x'`);
jsonb<{ kind: "sql"; sql: string }>().default({ kind: "sql", sql: "x" });
// @ts-expect-error a plain object is not a SQL default
text.default({ kind: "sql", sql: "'x'" });
