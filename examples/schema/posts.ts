import { table, int, text, bigint, oneOf, timestamptz } from "symmetria";
import { users } from "./users";

export const posts = table({
  id: int.auto,
  slug: text.unique,
  title: text,
  author: users.index,
  editor: users.nullable.inverse("edited"),
  state: oneOf("draft", "published").default("draft"),
  views: bigint.default(0n),
  createdAt: timestamptz.now,
});
