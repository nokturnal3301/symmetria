import { int, prepare, timestamptz } from "symmetria";
import { connect } from "../database";
import { appSchema } from "../schema";

// Works offline too: prepare() binds values without opening a connection.
const database = process.env.DATABASE_URL ? connect() : appSchema;

const serialize = (value: unknown): string =>
  JSON.stringify(value, (_key, field) =>
    typeof field === "bigint" ? field.toString() : field,
  );

try {
  const report = prepare(
    { since: timestamptz, top: int, minimumPosts: int },
    (parameters) => {
      const ranked = database
        .posts((post, { rowNumber }) => ({
          id: post.id,
          position: rowNumber().over({
            partitionBy: [post.authorId],
            orderBy: [post.views.descending, post.id.ascending],
          }),

          $where: [
            post.state.is.published,
            post.createdAt.atLeast(parameters.since),
          ],
        }))
        .cte("ranked_posts");

      // These totals cover all qualifying posts, not just the top-N projection.
      const totals = database
        .posts((post, { count, sum, maximum }) => ({
          authorId: post.authorId,
          publications: count(),
          totalViews: sum(post.views),
          latestPublication: maximum(post.createdAt),

          $where: [
            post.state.is.published,
            post.createdAt.atLeast(parameters.since),
          ],
          $groupBy: [post.authorId],
        }))
        .cte("author_totals");

      const eligible = totals((total) => ({
        authorId: total.authorId,
        publications: total.publications,
        totalViews: total.totalViews,
        latestPublication: total.latestPublication,
        $where: total.publications.atLeast(parameters.minimumPosts),
      })).cte("eligible_authors");

      return database.users((user, { innerJoin }) => {
        const stats = innerJoin(eligible, (total) =>
          total.authorId.is(user.id),
        );

        return {
          id: user.id,
          author: { name: user.name, email: user.email },
          stats: {
            publications: stats.publications,
            totalViews: stats.totalViews,
            latestPublication: stats.latestPublication,
          },
          best: user.posts((post) => ({
            title: post.title,
            views: post.views,
            editor: post.editor((editor) => ({ name: editor.name })),
            tags: post.tags((tag) => ({
              label: tag.label,
              $orderBy: tag.label.ascending,
            })),

            $where: post.id.in(
              ranked((rank) => ({
                id: rank.id,

                $where: rank.position.atMost(parameters.top),
              })),
            ),

            $orderBy: [post.views.descending, post.id.ascending],
          })),

          $orderBy: [stats.publications.descending, user.id.ascending],
        };
      });
    },
  );
  const parameters = {
    since: new Date("2020-01-01T00:00:00Z"),
    top: 2,
    minimumPosts: 1,
  };
  console.log("author report SQL", report.toSQL(parameters));

  if (process.env.DATABASE_URL) {
    const rows = await report.execute(parameters);
    // Bigint fields become strings at the HTTP/JSON boundary; SUM is already exact text.
    console.log("author report JSON", serialize(rows));
    console.log(
      "author report top 1 JSON",
      serialize(await report.execute({ ...parameters, top: 1 })),
    );
  }
} finally {
  await database.$close();
}
