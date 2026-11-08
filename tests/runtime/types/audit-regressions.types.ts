import { text, int, bool, jsonb } from "../../../packages/runtime/src";

text.nullable.default(null);
int.nullable.default(null);
bool.nullable.default(null);
jsonb<{ value: number }>().nullable.default(null);
// @ts-expect-error non-nullable text cannot default to SQL NULL
text.default(null);
