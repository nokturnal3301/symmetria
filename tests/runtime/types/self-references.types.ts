// Compile-only API contracts: bun run test:types.
import { schema, self, table, int, text } from "../../../packages/runtime/src";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

// Modular tables configure `self` with the same chain as table references.
const tasks = table({
  id: int.auto,
  title: text,
  parent: self.nullable.onDelete.cascade.inverse("subtasks"),
  reviewer: self.onDelete.setNull.inverse("reviews"),
  twin: self.unique.index.nullable.inverse("twinOf"),
});
const model = schema({ tasks });

{
  const rows = await model
    .tasks((task) => ({
      parentId: task.parentId,
      reviewerId: task.reviewerId,
      parent: task.parent((parent) => ({ title: parent.title })),
      subtasks: task.subtasks((subtask) => ({ id: subtask.id })),
      reviews: task.reviews.count(),
      twinOf: task.twinOf((twin) => ({ id: twin.id })),
    }))
    .execute();

  type ParentId = Expect<
    AreEqual<(typeof rows)[number]["parentId"], number | null>
  >;
  // setNull implies a nullable foreign key.
  type ReviewerId = Expect<
    AreEqual<(typeof rows)[number]["reviewerId"], number | null>
  >;
  type Subtasks = Expect<
    AreEqual<(typeof rows)[number]["subtasks"], { id: number }[]>
  >;
  type TwinOf = Expect<
    AreEqual<(typeof rows)[number]["twinOf"], { id: number } | null>
  >;
}

{
  // Without inverse(), a self reference has no reverse relation.
  const plain = schema({
    nodes: table({ id: int.auto, parent: self.nullable }),
  });
  await plain
    .nodes((node) => ({
      id: node.id,
      // @ts-expect-error unnamed self references expose no reverse relation
      children: node.children((_row: never) => ({})),
    }))
    .execute();
}
