import {
  table,
  one,
  maybe,
  int,
  text,
  bigint,
  oneOf,
  timestamptz,
} from "symmetria";
import { users } from "./users";

export const posts = table({
  id: int.auto,
  slug: text.unique,
  title: text,
  author: one(users.posts),
  editor: maybe(users.edited).noIndex,
  state: oneOf("draft", "published").default("draft"),
  views: bigint.default(0n),
  createdAt: timestamptz.now,
});
