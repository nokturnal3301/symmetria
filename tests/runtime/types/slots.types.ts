// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  link,
  one,
  maybe,
  many,
  self,
  int,
  text,
  timestamptz,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const users = table({
  id: int.auto,
  name: text,
  email: text.unique,
  posts: many,
  edited: many,
  profile: one,
  comments: many.cascade,
});
const tags = table({ id: int.auto, label: text.unique, posts: many });
const posts = table({
  id: int.auto,
  title: text,
  author: one(users.posts),
  editor: maybe(users.edited),
  tags: many(tags.posts).with({ addedAt: timestamptz.now }),
});
const profiles = table({ id: int.auto, bio: text, user: one(users.profile) });
const comments = table({
  id: int.auto,
  body: text,
  post: one(posts),
  author: one(users.comments).by("email"),
  parent: maybe(self.children).cascade,
  children: many,
});
const model = schema({ users, tags, posts, profiles, comments });

{
  // Slots are not columns; references are.
  type Post = Expect<
    Equal<
      typeof model.posts.$row,
      { id: number; title: string; authorId: number; editorId: number | null }
    >
  >;
  type User = Expect<
    Equal<typeof model.users.$row, { id: number; name: string; email: string }>
  >;
  type Comment = Expect<
    Equal<
      typeof model.comments.$row,
      {
        id: number;
        body: string;
        postId: number;
        authorId: string;
        parentId: number | null;
      }
    >
  >;
  // The junction is a table of the schema.
  type Link = Expect<
    Equal<
      typeof model.postsTags.$row,
      { postsId: number; tagsId: number; addedAt: Date }
    >
  >;
}

{
  const rows = await model.users((user) => ({
    name: user.name,
    posts: user.posts((post) => ({ title: post.title })),
    edited: user.edited.count(),
    profile: user.profile((profile) => ({ bio: profile.bio })),
    comments: user.comments((comment) => ({ body: comment.body })),
  }));
  type Rows = Expect<
    Equal<
      typeof rows,
      {
        name: string;
        posts: { title: string }[];
        edited: number;
        profile: { bio: string } | null;
        comments: { body: string }[];
      }[]
    >
  >;
  const feed = await model.posts((post) => ({
    author: post.author.name,
    editor: post.editor.name,
    tags: post.tags((tag) => ({ label: tag.label })),
  }));
  type Feed = Expect<
    Equal<
      typeof feed,
      { author: string; editor: string | null; tags: { label: string }[] }[]
    >
  >;
  const tagged = await model.tags((tag) => ({
    posts: tag.posts((post) => ({ title: post.title })),
  }));
  type Tagged = Expect<Equal<typeof tagged, { posts: { title: string }[] }[]>>;
  const tree = await model.comments((comment) => ({
    parent: comment.parent.body,
    children: comment.children((child) => ({ id: child.id })),
    post: comment.post.title,
  }));
  type Tree = Expect<
    Equal<
      typeof tree,
      { parent: string | null; children: { id: number }[]; post: string }[]
    >
  >;
  // The short form names the reverse side after the referencing table.
  model.posts((post) => ({ comments: post.comments.count() }));
}

model.posts.insert({
  title: "x",
  author: { connect: 1 },
  editor: { create: { name: "Ada", email: "a@x.test" } },
  tags: { connectOrCreate: [{ label: "sql" }] },
});
model.users.insert({
  name: "Ada",
  email: "a@x.test",
  posts: { create: [{ title: "x" }] },
});
// @ts-expect-error a slot is not a column
model.users.insert({ name: "Ada", email: "a@x.test", posts: 1 });

// @ts-expect-error no such slot
one(users.nope);
// @ts-expect-error a column is not a slot
one(users.name);
// @ts-expect-error many() joins two many slots
many(users.profile);
// @ts-expect-error a required reference cannot be set to NULL
one(users.posts).setNull;
maybe(users.posts).setNull;

{
  // A slot nobody claims is an error where the schema is built.
  const owners = table({ id: int.auto, pets: many, toys: many });
  const pets = table({ id: int.auto, owner: one(owners.pets) });
  // @ts-expect-error owners.toys is never claimed
  schema({ owners, pets });
}

{
  // Two references to the same slot.
  const owners = table({ id: int.auto, pets: many });
  const pets = table({
    id: int.auto,
    owner: one(owners.pets),
    keeper: one(owners.pets),
  });
  // @ts-expect-error owners.pets is claimed twice
  schema({ owners, pets });
}

{
  // The short form pairs with a slot named after the referencing table,
  // and the old spelling pairs by .inverse() name.
  const owners = table({ id: int.auto, pets: many, cats: many });
  const pets = table({ id: int.auto, owner: one(owners) });
  const cats = table({ id: int.auto, owner: owners.inverse("cats") });
  const zoo = schema({ owners, pets, cats });
  const rows = await zoo.owners((owner) => ({
    pets: owner.pets.count(),
    cats: owner.cats.count(),
  }));
  type Rows = Expect<Equal<typeof rows, { pets: number; cats: number }[]>>;
}

{
  // An explicit junction of two slots, with its own columns.
  const authors = table({ id: int.auto, books: many });
  const books = table({ id: int.auto, authors: many });
  const credits = link(authors.books, books.authors, { role: text });
  const library = schema({ authors, books, credits });
  type Credit = Expect<
    Equal<
      typeof library.credits.$row,
      { authorsId: number; booksId: number; role: string }
    >
  >;
  const rows = await library.authors((author) => ({
    books: author.books((book) => ({ id: book.id })),
  }));
  type Rows = Expect<Equal<typeof rows, { books: { id: number }[] }[]>>;
}

{
  // Named references, like junction().
  const people = table({ id: int.auto, name: text });
  const teams = table({ id: int.auto, title: text });
  const members = link({ person: people, team: teams }, { role: text });
  const club = schema({ people, teams, members });
  type Member = Expect<
    Equal<
      typeof club.members.$row,
      { personId: number; teamId: number; role: string }
    >
  >;
  club.people((person) => ({ teams: person.teams.count() }));
}

{
  // Inside a schema callback the table is a keyed link.
  const keyed = schema({
    users: { id: int.auto, name: text, posts: many },
    posts: ({ users }) => table({ id: int.auto, author: maybe(users) }),
  });
  const rows = await keyed.users((user) => ({ posts: user.posts.count() }));
  type Rows = Expect<Equal<typeof rows, { posts: number }[]>>;
  type Post = Expect<
    Equal<typeof keyed.posts.$row, { id: number; authorId: number | null }>
  >;
}

{
  // The form `symmetria pull` writes: keyed callbacks, claims and slots.
  const pulled = schema({
    categories: ({ categories }) =>
      table({
        id: int.auto,
        name: text,
        parent: maybe(categories.inverse("categoriesByParent")).noIndex.cascade,
        categoriesByParent: many,
      }),
    postTags: ({ posts, tags }) =>
      link({ post: posts, tag: tags, addedAt: timestamptz.now }),
    posts: ({ users }) =>
      table({
        id: int.auto,
        author: one(users).cascade,
        editor: maybe(users.inverse("postsByEditor")).noIndex.setNull,
        authorEmail: one(
          users
            .by("email")
            .column("author_email")
            .inverse("postsByAuthorEmail"),
        ).noIndex.onDelete.noAction.onUpdate.cascade,
        title: text,
      }),
    profiles: ({ users }) =>
      table({ id: int.auto, user: one(users).unique.cascade, bio: text }),
    tags: table({ id: int.auto, label: text.unique }),
    users: table({
      id: int.auto,
      email: text.unique,
      posts: many,
      postsByEditor: many,
      postsByAuthorEmail: many,
      profiles: one,
    }),
  });
  type Post = Expect<
    Equal<
      typeof pulled.posts.$row,
      {
        id: number;
        title: string;
        authorId: number;
        editorId: number | null;
        authorEmailId: string;
      }
    >
  >;
  const rows = await pulled.users((user) => ({
    posts: user.posts.count(),
    edited: user.postsByEditor((post) => ({ title: post.title })),
    profile: user.profiles((profile) => ({ bio: profile.bio })),
  }));
  type Rows = Expect<
    Equal<
      typeof rows,
      {
        posts: number;
        edited: { title: string }[];
        profile: { bio: string } | null;
      }[]
    >
  >;
  pulled.categories((category) => ({
    children: category.categoriesByParent.count(),
    tags: category.parent.name,
  }));
  pulled.posts((post) => ({ tags: post.tags.count() }));
}
