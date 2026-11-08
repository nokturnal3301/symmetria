// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  prepare,
  int,
  text,
  bool,
  type InferUpdate,
  type Page,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const users = table({ id: int.auto, name: text, active: bool.default(true) });
const posts = table({ id: int.auto, title: text, author: users, version: int });
const model = schema({ users, posts });

{
  type Count = Assert<
    Equal<ReturnType<typeof model.posts.count>, Promise<number>>
  >;
  type Filtered = Assert<
    Equal<
      ReturnType<ReturnType<typeof model.posts>["exists"]>,
      Promise<boolean>
    >
  >;
  type Lookup = Assert<
    Equal<
      ReturnType<ReturnType<typeof model.users.byId>["count"]>,
      Promise<number>
    >
  >;
  type Selected = Assert<
    Equal<
      ReturnType<ReturnType<typeof model.posts.as>["exists"]>,
      Promise<boolean>
    >
  >;
}
{
  const byName = prepare({ name: text }, (parameters) =>
    model.users((user) => ({ id: user.id }), {
      where: (user) => user.name.is(parameters.name),
    }),
  );
  type One = Assert<
    Equal<ReturnType<typeof byName.one>, Promise<{ id: number }>>
  >;
  type Maybe = Assert<
    Equal<ReturnType<typeof byName.maybeOne>, Promise<{ id: number } | null>>
  >;
  type Count = Assert<Equal<ReturnType<typeof byName.count>, Promise<number>>>;
  // @ts-expect-error parameters are required
  byName.one();
  const update = prepare({ id: int }, (parameters) =>
    model.users.byId(parameters.id).update({ active: false }),
  );
  // @ts-expect-error prepared mutations only execute
  update.one({ id: 1 });
  type Result = Assert<
    Equal<Awaited<ReturnType<typeof update>>, { affectedRows: number }>
  >;
}
{
  const feed = model.posts((post) => ({ id: post.id }), {
    orderBy: (post) => post.id.ascending,
  });
  type Paged = Assert<
    Equal<Awaited<ReturnType<typeof feed.page>>, Page<{ id: number }>>
  >;
  feed.page({ size: 1, before: null });
  // @ts-expect-error cursors belong to their own query shape
  feed.page({ size: 1, before: "x" });
}
{
  const conditional = model.posts
    .insert({ title: "x", authorId: 1, version: 1 })
    .onConflict("id")
    .doUpdate(
      { title: "y" },
      { where: (post, incoming) => incoming.version.above(post.version) },
    )
    .returning((post, { coalesce }) => ({
      id: post.id,
      title: coalesce(post.title, ""),
    }));
  type Optional = Assert<
    Equal<
      Awaited<ReturnType<typeof conditional.execute>>,
      { id: number; title: string } | null
    >
  >;
  type Patch = InferUpdate<typeof model.users>;
  type PatchKeys = Assert<
    Equal<"name" extends keyof Patch ? true : false, true>
  >;
  const patch: Patch = { name: "Ada" };
  // @ts-expect-error unknown field
  const wrong: Patch = { nope: 1 };
  type Standalone = Assert<
    Equal<"active" extends keyof InferUpdate<typeof users> ? true : false, true>
  >;
}
