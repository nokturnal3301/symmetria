// Compile-only API contracts: bun run test:types.
import {
  schema,
  table,
  index,
  int,
  text,
  uuid,
  customType,
  type QueryColumn,
} from "../../../packages/runtime/src";

type Equal<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;
{
  const database = schema({
    users: { id: int },
    groups: { id: int },
    membership: ({ users, groups }) =>
      table({ user: users.inverse("memberships"), group: groups }).primaryKey(
        (membership) => [membership.userId],
      ),
  });

  {
    database.users((users, { innerJoin }) => {
      // @ts-expect-error a single FK primary key is not a many-to-many junction
      const groups = innerJoin(users.groups);

      return {};
    });
  }
}

{
  schema({
    users: table({ id: uuid }),
    posts: ({ users }) =>
      table({
        id: int,
        author: users.index,
        editor: users.nullable.inverse("edited"),
      }).indexes((posts) => {
        const author: QueryColumn<string, "authorId"> = posts.authorId;
        const editor: QueryColumn<string | null, "editorId"> = posts.editorId;
        // @ts-expect-error UUID references retain their value type inside local callbacks
        posts.authorId.is(123);

        return { byAuthor: index(author).where(editor.isNot(null)) };
      }),
  });
  const identifier = customType<{ value: string }>("text", {
    encode: (value) => value.value,
    decode: (value) => ({ value: String(value) }),
  });
  schema({
    tenants: table({ code: identifier }).primaryKey((tenants) => [
      tenants.code,
    ]),
    posts: ({ tenants }) =>
      table({ id: int, tenant: tenants }).checks((posts) => {
        // @ts-expect-error non-id custom PK types are inferred through references too
        posts.tenantId.is("wrong");

        return { existingTenant: posts.tenantId.isNot(null) };
      }),
  });
  schema.keys({ users: uuid, teams: int })({
    users: ({ teams }) =>
      table({ id: uuid, team: teams.nullable.inverse("members") }).indexes(
        (users) => {
          // @ts-expect-error team identifiers are numbers, including in cyclic definitions
          users.teamId.is("wrong");

          return { byTeam: index(users.teamId) };
        },
      ),
    teams: ({ users }) =>
      table({ id: int, owner: users.inverse("ownedTeams") }),
  });
  // @ts-expect-error checks require predicates
  table({ id: int }).checks((records) => ({ invalid: records.id }));
  // @ts-expect-error explicit keys cannot be empty
  table({ id: int }).primaryKey(() => []);
}
