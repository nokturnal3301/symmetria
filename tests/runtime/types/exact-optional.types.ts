// Compile-only API contracts: bun run test:types. The repository compiles with
// exactOptionalPropertyTypes, so optional values passed as `T | undefined` must type-check.
import {
  createDatabase,
  createProfiler,
  int,
  jsonb,
  schema,
  table,
  text,
  type PageCursor,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

// The Standard Schema V1 shapes as published by the spec (Zod, Valibot, ArkType).
interface SpecIssue {
  readonly message: string;
  readonly path?:
    | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
    | undefined;
}
type SpecResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<SpecIssue> };
interface SpecSchema<Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => SpecResult<Output> | Promise<SpecResult<Output>>;
    readonly types?:
      | { readonly input: Output; readonly output: Output }
      | undefined;
  };
}

declare const settings: SpecSchema<{ theme: "light" | "dark" }>;
declare const profiler: ReturnType<typeof createProfiler> | undefined;
declare const readOnly: boolean | undefined;
declare const after: PageCursor<{ id: number }> | undefined;
declare const nestedEditor: { connect: number } | undefined;
declare const nestedEditorId: number | null | undefined;

const model = schema({ users: { id: int.auto, settings: jsonb(settings) } });
const database = createDatabase({
  schema: model,
  driver: postgres({ url: "postgres://localhost/app", profiler }),
});

{
  const rows = await database
    .users((user) => ({
      theme: user.settings.path("theme"),
      $where: user.settings.path("theme").is("dark"),
    }))
    .execute();
  type Theme = Expect<
    AreEqual<(typeof rows)[number]["theme"], "light" | "dark" | null>
  >;

  await database
    .users((user) => ({ id: user.id, $orderBy: user.id.ascending }))
    .page({ size: 10, after });
  await database.$transaction(async () => undefined, { readOnly });
}

// Nullable references accept `undefined` in the nested-insert form as well as the flat one.
{
  const authors = table({ id: int.auto, name: text });
  const posts = table({
    id: int.auto,
    title: text,
    author: authors.inverse("written"),
    editor: authors.nullable.inverse("edited"),
  });
  const blog = schema({ authors, posts });

  blog.posts.insert({ title: "a", authorId: 1, editor: nestedEditor });
  blog.posts.insert({ title: "a", authorId: 1, editorId: nestedEditorId });
  blog.posts.insert({
    title: "a",
    author: { connect: 1 },
    editor: nestedEditor,
  });
  blog.posts.insert({ title: "a", author: { connect: 1 } });
  // @ts-expect-error a required reference cannot be `undefined`
  blog.posts.insert({
    title: "a",
    author: undefined as { connect: number } | undefined,
  });
}
