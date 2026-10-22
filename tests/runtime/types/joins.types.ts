import { model, type Article } from "../../fixtures/keyed-schema";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

type ArticleMatches = Expect<
  AreEqual<
    Article,
    {
      title: string;
      authorName: string | null;
      editorName: string | null;
    }
  >
>;

const innerEditor = model.posts((posts, { innerJoin }) => {
  const editor = innerJoin(posts.editor);

  return { title: posts.title, editorName: editor.name };
});
type InnerEditorMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof innerEditor.execute>>,
    {
      title: string;
      editorName: string;
    }[]
  >
>;

const leftProfile = model.users((users, { leftJoin }) => {
  const profile = leftJoin(users.profile);

  return { id: profile.id, bio: profile.bio };
});
type LeftProfileMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof leftProfile.execute>>,
    {
      id: number | null;
      bio: string | null;
    }[]
  >
>;

const innerProfile = model.users((users, { innerJoin }) => {
  const profile = innerJoin(users.profile);

  return { id: profile.id, bio: profile.bio };
});
type InnerProfileMatches = Expect<
  AreEqual<
    Awaited<ReturnType<typeof innerProfile.execute>>,
    {
      id: number;
      bio: string | null;
    }[]
  >
>;

const joinedTags = model.posts((posts, { leftJoin }) => {
  const tags = leftJoin(posts.tags);

  return { title: posts.title, tagName: tags.name };
});
type JoinedTagsMatch = Expect<
  AreEqual<
    Awaited<ReturnType<typeof joinedTags.execute>>,
    {
      title: string;
      tagName: string | null;
    }[]
  >
>;

const selectedForeignKey = model.posts((posts) => ({
  authorId: posts.authorId,
  editorId: posts.editorId,
}));
type ForeignKeysMatch = Expect<
  AreEqual<
    Awaited<ReturnType<typeof selectedForeignKey.execute>>,
    {
      authorId: string;
      editorId: string | null;
    }[]
  >
>;
{
  // @ts-expect-error author is unavailable until its join
  model.posts((posts) => ({ name: author.name }));
  model.posts((posts, { leftJoin }) => {
    const author = leftJoin(posts.author);

    // @ts-expect-error only declared source handles are available
    return { name: users.name };
  });
  model.posts((posts, { leftJoin }) => {
    const author = leftJoin(posts.author);

    // @ts-expect-error editor has not been joined
    return { $where: editor.name.is("Ada") };
  });
  // @ts-expect-error columns retain their value types
  model.posts((posts) => ({ $where: posts.title.is(42) }));
  model.users((users, { leftJoin }) => {
    const profile = leftJoin(users.profile);

    // @ts-expect-error column comparison checks value types
    return { $where: users.name.is(profile.id) };
  });
  // @ts-expect-error an unselected query cannot execute
  model.posts((posts) => ({ $where: posts.id.isNot(null) })).execute();
  // @ts-expect-error result field names do not declare JavaScript variables
  model.posts((posts) => ({ heading: posts.title, $where: heading.is("x") }));
  // @ts-expect-error a query with no selection cannot be executed
  model.posts.execute();
}
