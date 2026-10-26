// Compile-only API contracts: bun run test:types.
import { schema, type Link, uuid, int } from "../../../packages/runtime/src";
import { model } from "../../fixtures/keyed-schema";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

{
  const tripleReferences = schema({
    users: { id: uuid },
    teams: { id: uuid },
    workspaces: { id: uuid },
    records: ({ users, teams, workspaces }) => ({
      user: users,
      team: teams,
      workspace: workspaces,
    }),
  });

  {
    await tripleReferences
      .users((users) => ({
        id: users.id,
        records: users.records((records) => ({
          userId: records.userId,
          teamId: records.teamId,
          workspaceId: records.workspaceId,
        })),
        // @ts-expect-error three-way associations do not create automatic users.teams relations
        teams: users.teams((_row: never) => ({})),
      }))
      .execute();
  }
}

{
  const result = await model
    .users((users) => ({
      id: users.id,
      name: users.name,
      profile: users.profile((profile) => ({
        id: profile.id,
        bio: profile.bio,
        userId: profile.userId,
      })),
      authored: users.authored((authored) => ({
        id: authored.id,
        title: authored.title,
        authorId: authored.authorId,
        editorId: authored.editorId,
        teamId: authored.teamId,
        team: authored.team((team) => ({ id: team.id, name: team.name })),
        tags: authored.tags((tags) => ({ id: tags.id, name: tags.name })),
      })),
      edited: users.edited((edited) => ({
        id: edited.id,
        title: edited.title,
        authorId: edited.authorId,
        editorId: edited.editorId,
        teamId: edited.teamId,
      })),
    }))
    .execute();
  type ProfileMatches = Expect<
    AreEqual<
      (typeof result)[number]["profile"],
      {
        id: number;
        bio: string | null;
        userId: string;
      } | null
    >
  >;
  type TeamMatches = Expect<
    AreEqual<
      (typeof result)[number]["authored"][number]["team"],
      { id: string; name: string } | null
    >
  >;
  type TagsMatch = Expect<
    AreEqual<
      (typeof result)[number]["authored"][number]["tags"],
      { id: string; name: string }[]
    >
  >;
  type InsertMatches = Expect<
    AreEqual<
      typeof model.profiles.$insert,
      { id?: undefined; bio?: string | null | undefined; userId: string }
    >
  >;

  const tree = await model
    .categories((categories) => ({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      children: categories.children((children) => ({
        id: children.id,
        name: children.name,
        parentId: children.parentId,
        parent: children.parent((parent) => ({
          id: parent.id,
          name: parent.name,
          parentId: parent.parentId,
        })),
      })),
    }))
    .execute();
  type ParentMatches = Expect<
    AreEqual<
      (typeof tree)[number]["children"][number]["parent"],
      typeof model.categories.$row | null
    >
  >;

  await model
    .users((users) => ({
      id: users.id,
      name: users.name,
      // @ts-expect-error renamed inverses remove their old automatic name
      posts: users.posts((_row: never) => ({})),
    }))
    .execute();
  await model
    .teams((teams) => ({
      id: teams.id,
      name: teams.name,
      // @ts-expect-error users and teams are identical shapes but distinct identities
      profile: teams.profile((_row: never) => ({})),
    }))
    .execute();
  await model
    .users((users) => ({
      id: users.id,
      name: users.name,
      authored: users.authored((authored) => ({
        id: authored.id,
        title: authored.title,
        authorId: authored.authorId,
        editorId: authored.editorId,
        teamId: authored.teamId,
        // @ts-expect-error invalid nested relation must not escape through inference
        nonexistent: authored.nonexistent((_row: never) => ({})),
      })),
    }))
    .execute();
  await model
    .users((users) => ({
      id: users.id,
      name: users.name,
      profile: users.profile((profile) => ({
        id: profile.id,
        bio: profile.bio,
        userId: profile.userId,
      })),
      // @ts-expect-error a valid sibling must not hide an invalid relation
      posts: users.posts((_row: never) => ({})),
    }))
    .execute();
  await model
    .users((users) => ({
      id: users.id,
      name: users.name,
      authored: users.authored((authored) => ({
        id: authored.id,
        title: authored.title,
        authorId: authored.authorId,
        editorId: authored.editorId,
        teamId: authored.teamId,
        team: authored.team((team) => ({ id: team.id, name: team.name })),
        // @ts-expect-error a valid nested sibling must not hide an invalid relation
        nonexistent: authored.nonexistent((_row: never) => ({})),
      })),
    }))
    .execute();
  const plain = await model
    .users((users) => ({ id: users.id, name: users.name }))
    .execute();
  type PlainRowMatches = Expect<
    AreEqual<(typeof plain)[number], typeof model.users.$row>
  >;
  const editor = await model
    .posts((posts) => ({
      id: posts.id,
      title: posts.title,
      authorId: posts.authorId,
      editorId: posts.editorId,
      teamId: posts.teamId,
      editor: posts.editor((editor) => ({ id: editor.id, name: editor.name })),
    }))
    .execute();
  type EditorMatches = Expect<
    AreEqual<(typeof editor)[number]["editor"], typeof model.users.$row | null>
  >;
  schema({
    users: { id: uuid },
    posts: (references) => {
      // @ts-expect-error callbacks only expose actual table keys
      const typo = references.usres;
      void typo;

      return { id: uuid, author: references.users };
    },
  });
  // @ts-expect-error colliding inverse names must fail during type checking
  schema({
    users: { id: uuid },
    posts: ({ users }) => ({ id: uuid, author: users, editor: users }),
  });
  schema({
    users: { id: uuid },
    // @ts-expect-error undefined is not a column (even with noUncheckedIndexedAccess)
    posts: ({ users }) => ({
      id: uuid,
      invalid: undefined,
      author: users,
    }),
  });
}
