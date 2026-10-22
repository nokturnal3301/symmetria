// Compile-only API contracts: bun run test:types.
import {
  junction,
  schema,
  table,
  int,
  text,
  bool,
  bigint,
  timestamptz,
  sql,
  prepare,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

const countries = table({ code: text.primaryKey, label: text });
const users = table({
  id: int.auto,
  name: text,
  country: countries.nullable,
}).computed((users) => ({ upperName: sql<string>`upper(${users.name})` }));
const posts = table({
  id: int.auto,
  title: text,
  author: users,
  editor: users.nullable.inverse("edited"),
  published: bool,
  visits: bigint,
  createdAt: timestamptz,
});
const profiles = table({ id: int.auto, user: users.unique, bio: text });
const tags = table({ id: int.auto, label: text });
const postTags = junction({ post: posts, tag: tags });
const model = schema({ countries, users, posts, profiles, tags, postTags });
{
  const query = prepare({ name: text, size: int }, (parameters) =>
    model.users((users) => ({
      posts: users.posts((posts) => ({
        title: posts.title,
        $where: posts.author.name.is(parameters.name),
        $limit: parameters.size,
      })),
    })),
  );
  type PreparedRelations = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      { posts: { title: string }[] }[]
    >
  >;
  const branch = model.posts((posts) => ({ $where: posts.author.id.above(0) }));
  const expanded = branch((posts) => ({ label: posts.author.country.label }));
  type NullablePath = Assert<
    Equal<
      Awaited<ReturnType<typeof expanded.execute>>,
      { label: string | null }[]
    >
  >;

  {
    model.posts((posts, { innerJoin }) => {
      const reviewer = innerJoin(model.users.as("reviewer"), (reviewer) =>
        (() => {
          // Outer paths can register their dependency JOINs inside ON.
          posts.author.name;

          return posts.editorId.is(reviewer.id);
        })(),
      );

      return {};
    });
    model.users((users) =>
      (() => {
        // @ts-expect-error to-many relations need a collection projection
        users.posts.title;

        // @ts-expect-error nonexistent path
        users.country.missing;

        const page = users.posts(() => ({ $limit: 2 }));
        // @ts-expect-error quantifiers operate on filtered relations before pagination
        page.every((posts: never) => posts);

        model.users((users, { join }) => {
          const joined0 = join(
            // @ts-expect-error filtered relations cannot be JOIN sources
            users.posts((posts) => ({ $where: posts.published.is(true) })),
          );

          return {};
        });

        return { id: users.id };
      })(),
    );
  }
}
