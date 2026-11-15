import { link, table, int, text } from "symmetria";
import { posts } from "./posts";

export const tags = table({
  id: int.auto,
  label: text.unique,
});

// A link's rows go when either side is deleted.
export const postTags = link({ post: posts, tag: tags });
