// Compile-only API contracts: bun run test:types.
import {
  schema,
  createDatabase,
  int,
  text,
  type Transaction,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";

type Equal<Actual, Expected> =
  (<Value>() => Value extends Actual ? 1 : 2) extends <
    Value,
  >() => Value extends Expected ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

const appSchema = schema({
  users: { id: int.auto, name: text },
  posts: ({ users }) => ({ id: int.auto, author: users, title: text }),
});
const database = createDatabase({
  schema: appSchema,
  driver: postgres("postgres://localhost/postgres"),
});
type ApplicationTransaction = Transaction<typeof database>;
type CallbackTransaction = Parameters<
  Parameters<typeof database.$transaction>[0]
>[0];
type ExactContext = Assert<Equal<ApplicationTransaction, CallbackTransaction>>;
type SchemaContext = Assert<
  Equal<Transaction<typeof appSchema>, ApplicationTransaction>
>;
type SavepointContext = Assert<
  Equal<Transaction<ApplicationTransaction>, ApplicationTransaction>
>;

const findAuthorPosts = (
  transaction: ApplicationTransaction,
  authorId: number,
) =>
  transaction
    .posts((posts) => ({
      title: posts.title,
      author: posts.author.name,
      $where: posts.authorId.is(authorId),
    }))
    .execute();

type ServiceResult = Assert<
  Equal<
    Awaited<ReturnType<typeof findAuthorPosts>>,
    { title: string; author: string }[]
  >
>;

database.$transaction(async (transaction) => {
  await findAuthorPosts(transaction, 1);
  // @ts-expect-error a pool-bound database is not a transaction context
  await findAuthorPosts(database, 1);
  await transaction.$transaction((savepoint) => findAuthorPosts(savepoint, 1));
  const scoped: ApplicationTransaction = transaction;
  // @ts-expect-error transaction contexts cannot close the pool
  scoped.$close();
  // @ts-expect-error concurrent indexes are unavailable inside a transaction
  scoped.$createIndexes({ concurrently: true });
  // @ts-expect-error inferred transaction tables reject incorrect column values
  scoped.posts.update({ title: 123 });
  // @ts-expect-error another schema cannot be passed to an application service
  await findAuthorPosts(schema({ unrelated: { id: int } }), 1);
});

// @ts-expect-error transaction inference requires a database transaction API
type InvalidContext = Transaction<{ users: unknown }>;

{
  const model = schema({ records: { id: int, name: text } });
  model.$transaction(async (transaction) => {
    // @ts-expect-error a scoped transaction cannot close the shared pool
    await transaction.$close();
    // @ts-expect-error nested savepoints cannot change isolation
    await transaction.$transaction(async () => 1, {
      isolationLevel: "serializable",
    });
    // @ts-expect-error scoped tables preserve column value types
    transaction.records.update({ name: 123 });
  });
}
