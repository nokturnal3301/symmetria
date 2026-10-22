// Compile-only API contracts: bun run test:types.
import {
  schema,
  int,
  text,
  bool,
  bigint,
  jsonb,
} from "../../../packages/runtime/src";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const settings = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) =>
      typeof value === "object" && value !== null
        ? { value: value as { theme: string; tags: string[] } }
        : { issues: [{ message: "object expected" }] },
  },
};
const model = schema({
  users: { id: int.auto, name: text, active: bool, settings: jsonb(settings) },
  posts: ({ users }) => ({
    id: int.auto,
    title: text,
    author: users,
    tags: text.array,
    scores: bigint.array.nullable,
  }),
});

{
  type Settings = Expect<
    AreEqual<
      typeof model.users.$row.settings,
      { theme: string; tags: string[] }
    >
  >;
  const scoped = model.$scope({ users: (users) => users.active.is(true) });
  type Same = Expect<AreEqual<typeof scoped, typeof model>>;
  scoped.$scope({ posts: (posts) => posts.title.is("x") });
  // @ts-expect-error unknown tables are rejected
  model.$scope({ comments: (comments) => comments.id.is(1) });
  // @ts-expect-error scope callbacks only see the table's own columns
  model.$scope({ users: (users) => users.missing.is(1) });
  model.posts.delete().where((posts) => posts.author.name.is("Ada"));
  model.users
    .update({ active: false })
    .where((users) => users.posts.some((posts) => posts.title.is("x")));
  // @ts-expect-error unknown relations stay rejected in mutation predicates
  model.posts.delete().where((posts) => posts.nothing.id.is(1));
  await model.$transaction(async (transaction) => {
    const inner = transaction.$scope({
      users: (users) => users.active.is(true),
    });
    type Transactional = Expect<AreEqual<typeof inner, typeof transaction>>;
    await inner.users((users) => ({ id: users.id }));
  });

  for await (const page of model
    .users((users) => ({
      id: users.id,
      name: users.name,
      $orderBy: users.id.ascending,
    }))
    .pages({ size: 10 })) {
    type Items = Expect<
      AreEqual<typeof page.items, { id: number; name: string }[]>
    >;
  }
}

{
  type Tags = Expect<AreEqual<typeof model.posts.$row.tags, string[]>>;
  type Scores = Expect<
    AreEqual<typeof model.posts.$row.scores, bigint[] | null>
  >;
  model.posts((posts) => ({ $where: posts.tags.has("x") }));
  model.posts((posts) => ({ $where: posts.scores.has(5n) }));
  model.posts((posts) => ({ $where: posts.tags.contains(["x"]) }));
  model.posts((posts) => ({ $where: posts.tags.overlaps(["x"]) }));
  model.posts((posts) => ({ count: posts.tags.length().as("count") }));
  model.posts((posts) => ({
    $where: posts.title.search("bun", { language: "english" }),
  }));
  model.posts((posts) => ({
    id: posts.id,
    searchRank: posts.title.searchRank("bun"),
  }));
  // @ts-expect-error array elements keep their type
  model.posts((posts) => ({ $where: posts.tags.has(1) }));
  // @ts-expect-error has() exists on array columns only
  model.posts((posts) => ({ $where: posts.title.has("x") }));
  // @ts-expect-error search() exists on text columns only
  model.posts((posts) => ({ $where: posts.id.search("x") }));
  // @ts-expect-error inserts require arrays for array columns
  model.posts.insert({ title: "t", authorId: 1, tags: "x" });
}
