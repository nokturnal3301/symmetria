// Compile-only API contracts: bun run test:types.
import {
  table,
  schema,
  int,
  text,
  jsonb,
  oneOf,
  sql,
  when,
  and,
  type QueryColumn,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;
{
  const users = table({ id: int, firstName: text, lastName: text }).computed(
    (users) => ({
      fullName: sql<string>`concat_ws(' ', ${users.firstName}, ${users.lastName})`,
    }),
  );
  const posts = table({ id: int, title: text, author: users });
  const model = schema({ users, posts });
  const query = model.users
    .as("writers")((writers) => ({ fullName: writers.fullName }))
    .prepare();
  type ComputedResult = Assert<
    Equal<Awaited<ReturnType<typeof query.execute>>, { fullName: string }[]>
  >;

  {
    // @ts-expect-error computed fields are read-only
    model.users.insert({ id: 1, firstName: "A", lastName: "B", fullName: "C" });
  }
}

{
  const model = schema({
    records: { id: int, state: oneOf("draft", "published") },
  });
  const query = model.records((records) => ({
    id: records.id,
    $where: and(
      records.state.is.published,
      when(0, (value) => records.id.is(value)),
      when(undefined, () => records.id.is(9)),
    ),
  }));

  {
    // @ts-expect-error enum predicates only contain declared labels
    model.records((records) => ({ $where: records.state.is.archived }));
  }
}

{
  const model = schema({
    records: {
      id: int,
      metadata: jsonb<{ settings?: { theme: string }; tags: string[] }>(),
    },
  });
  const query = model.records((records) => ({
    theme: records.metadata.path("settings", "theme").as("theme"),
    $where: records.metadata.path("tags").contains(["sql"]),
  }));

  {
    model.records((records) =>
      (() => {
        // @ts-expect-error JSON property names are checked
        records.metadata.path("settings", "missing");

        const theme: QueryColumn<string | null, "metadata"> =
          records.metadata.path("settings", "theme");

        return { metadata: theme };
      })(),
    );
  }
}

{
  const model = schema({
    countries: { id: int, label: text },
    users: ({ countries }) => ({
      id: int,
      name: text,
      country: countries.nullable,
    }),
    posts: ({ users }) => ({
      id: int,
      title: text,
      author: users,
      editor: users.nullable.inverse("edited"),
    }),
  });
  const query = model.posts((posts, { innerJoin, leftJoin }) => {
    const author = innerJoin(posts.author);
    const country = leftJoin(author.country);
    const reviewer = leftJoin(posts.editor.as("reviewer"));

    return {
      title: posts.title,
      author: author.name,
      country: country.label,
      reviewer: reviewer.name,
    };
  });
  type Result = Assert<
    Equal<
      Awaited<ReturnType<typeof query.execute>>,
      {
        title: string;
        author: string;
        country: string | null;
        reviewer: string | null;
      }[]
    >
  >;

  {
    model.posts((posts, { innerJoin }) => {
      // @ts-expect-error JOIN requires a relation or foreign key
      const id = innerJoin(posts.id);

      return {};
    });
    model.posts((posts, { innerJoin }) => {
      // @ts-expect-error relation names are checked
      const writer = innerJoin(posts.writer);

      return {};
    });
    model.posts((posts, { innerJoin }) => {
      const author = innerJoin(posts.author);
      const joined1 = innerJoin(posts.author);

      return {};
    });
    model.posts((posts, { innerJoin }) => {
      const joined0 = innerJoin(
        // @ts-expect-error filtered aggregate scopes cannot be used as JOIN sources
        posts.author((author) => ({ $where: author.id.is(1) })),
      );

      return {};
    });
  }
}
