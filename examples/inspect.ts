import { connect } from "./database";
import { recentPosts } from "./queries";

const db = connect();

try {
  const report = await recentPosts(db)({ limit: 5 }).inspect({
    explain: true,
  });
  console.log(report);
} finally {
  await db.$close();
}
