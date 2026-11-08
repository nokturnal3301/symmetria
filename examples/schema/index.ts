import { schema } from "symmetria";

import { users } from "./users";
import { posts } from "./posts";
import { tags, postTags } from "./tags";

export const appSchema = schema({ users, posts, tags, postTags });
