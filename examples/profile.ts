import { createProfiler } from "symmetria";
import { connect } from "./database";
import { authorFeed } from "./queries";

const profiler = createProfiler();
const database = connect(profiler);

try {
  await profiler.trace("author feed", () => authorFeed(database).execute());
  console.log(profiler.snapshot());
} finally {
  await database.$close();
}
