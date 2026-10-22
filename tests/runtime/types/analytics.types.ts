// Compile-only API contracts: bun run test:types.
import {
  schema,
  int,
  text,
  bigint,
  rowNumber,
} from "../../../packages/runtime/src";

const model = schema({
  entries: { id: int, team: text, parentId: int.nullable, amount: bigint },
});

const ranked = model
  .entries((entries) => ({
    id: entries.id,
    amount: entries.amount,
    position: rowNumber().over({
      partitionBy: [entries.team],
      orderBy: [entries.amount.descending, entries.id.ascending],
    }),
    $where: entries.team.is("A"),
  }))
  .cte("ranked", { materialized: false });
{
  // @ts-expect-error window functions preserve bigint values
  ranked((ranked) => ({ $where: ranked.position.is("wrong") }));
  model
    .entries((entries) => ({ id: entries.id }))
    .recursive("tree", () =>
      // @ts-expect-error the recursive term must preserve anchor column types
      model.entries((entries) => ({ id: entries.team })),
    );
}
