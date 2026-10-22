import { junction, table, int, text } from "symmetria";
import { posts } from "./posts";

export const tags = table({
  id: int.auto,
  label: text.unique,
});

export const postTags = junction({
  post: posts.onDelete.cascade,
  tag: tags.onDelete.cascade,
});
