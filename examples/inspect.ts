import { connect } from "./database";
import { recentPosts } from "./queries";

const database = connect();

try {
  const report = await recentPosts(database)(() => ({ $limit: 5 })).inspect({
    explain: true,
  });
  console.log(report);
} finally {
  await database.$close();
}
