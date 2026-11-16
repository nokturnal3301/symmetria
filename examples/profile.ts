import { createProfiler } from "symmetria";
import { connect } from "./database";
import { authorFeed } from "./queries";

const profiler = createProfiler();
const db = connect(profiler);

try {
  await profiler.trace("author feed", () => authorFeed(db).execute());
  console.log(profiler.snapshot());
} finally {
  await db.$close();
}
