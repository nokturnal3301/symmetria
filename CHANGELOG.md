# Changelog

## 3.7.0 — 2026-11-28

Fixes from two rounds after 3.6.0: PostgreSQL 19, raw SQL in counted and paged
queries and default values, then a bug hunt over reads with aggregates, values
on every way in and out, transactions, migration generation, `pull`, the command
line and relations.

### Runtime (`symmetria`)

- PostgreSQL 19 upserts report `DuplicateConflictKeyError` when two input rows
  match the same unique key, just as earlier server versions do.
- `count()` and `exists()` now use the rows produced by raw aggregates,
  set-returning functions and mixed aggregate/window reports. Raw window ranks
  no longer restart on each cursor page. If two result rows share a cursor after
  expansion, `page()` refuses it; `stream()` reads every row. A page with
  `forUpdate` or `forShare` is read from the table itself, as before, and locks
  its rows and the one row read ahead. Over a window function, such a page with
  `of` reports PostgreSQL's own error
  (`FOR UPDATE is not allowed with window functions`) instead of a `TypeError`.
  A page over raw SQL that PostgreSQL cannot inline (a volatile function such as
  `random()`, a set-returning one such as `unnest()`) now reads the filtered
  rows on every page; ordinary expressions cost nothing extra.
- **Changed:** `sum()` and `average()` of a `real` or `doublePrecision` column
  or expression return the float PostgreSQL computes with all its digits. They
  went through PostgreSQL's float-to-numeric cast, which keeps 15 significant
  digits of a `doublePrecision` and 6 of a `real`: a `real` sum of `123456.78`
  read `"123457"`, and `2^53` read `"9007199254740990"`. `0.1` and `0.2` now sum
  to `"0.30000000000000004"`, not `"0.3"`. The same holds in grouped queries,
  `aggregate()`, relation aggregates, `.over()` windows, nested results and
  `$batch()`, and a comparison or ordering on such a sum (`having`, a `where`
  over a relation's sum, `orderBy`) sees the same digits. Sums of integers,
  bigints, decimals and JSON numbers are unchanged, and page cursors stay valid.
- An array of two or more dimensions, which only SQL written outside Symmetria
  can store, is refused when it is read
  (`multidimensional arrays are not supported`), on both drivers and inside
  nested results, `$batch()` and streams. It came back as wrong values: `int[]`
  as `[NaN, NaN]`, `numeric[]` as `["1.5,2.5", …]`, `text[]` as nested arrays.
- `get()`, `find()`, `byId()`, `by.<key>()` and the object form of `where`
  accept a value that is an array for a column whose values are arrays: a
  `customType()` read as `[from, to]`, a `vector` primary key, a domain over
  `jsonb` or over an array. They refused it with "takes one value". A list given
  for a scalar column is still refused.
- A prepared `numeric` or `bigint` parameter selected inside a nested object or
  collection reads as it does at the top level: `"1e3"` came back as `"1e3"`
  instead of `"1000"`, and a bigint beyond the type's range came back instead of
  failing.
- An upsert keyed by a `real[]` or `doublePrecision[]` column no longer refuses
  two different keys as duplicates when they hold `NaN`, `Infinity` or
  `-Infinity`.
- Bulk upserts distinguish timestamp keys in years 1–99 from 1901–1999. Page
  cursors for filters binding `NaN`, `Infinity` or `-Infinity` no longer work on
  a different filter. Restart those pages after upgrading; other cursors keep
  their fingerprints.
- Cursor pagination can resume on long text sort keys and on arrays whose first
  index is not 1. Both drivers read those one-dimensional arrays, including
  `box[]`, as ordinary JavaScript arrays.
- A damaged or made-up page cursor whose values have the right form but that no
  type of the ordering column's family could hold is refused with
  `invalid page cursor or cursor from another query` before any SQL is sent,
  instead of surfacing as a database error: an integer beyond `bigint`, February
  31, year 0000, a zone offset of `+99`, text that is no time or interval,
  `1e400000` for a numeric column, a NUL character. A value is held to the
  widest type of its family (any integer to `bigint`, a float to
  `doublePrecision`) and an enum label is left to PostgreSQL, because the
  database may be a migration ahead of a running process: a column already
  widened, a label its schema does not list yet. The reference now says what a
  cursor holds: it is not encrypted or signed and carries the text of the row's
  ordering values, also of ordering columns the projection leaves out.
- `symmetria/pg` with `prepare: true`: a value node-postgres could not turn into
  text (an object holding a BigInt such as a row with a `bigint` column, a
  circular object, an object whose `toJSON()` or `toPostgres()` throws), passed
  inside a transaction or a session, broke that statement on the connection:
  every later run of the same text there failed with
  `prepared statement "symmetria_N" does not exist` until the pool replaced the
  connection. The transaction still fails with the original error and rolls
  back, and the statement keeps working afterwards. A JSON value now fails
  before the statement is sent; after any other failure of this kind the
  connection is closed when the transaction or session ends.
- `symmetria/pg` with `prepare: true`: after a column changed its type, only the
  first of several calls in flight on different connections ran again; the
  others failed with `cached plan must not change result type`. Every call
  outside a transaction now runs again under the statement's new name, including
  a statement of `driver.session()` outside a transaction. A transaction still
  fails once, as documented.
- A many-to-many of a table with itself (followers and following) can be
  declared: two slots of the table joined by
  `link(users.following, users.followers)`. It was refused as an ambiguous
  relation name, with advice to pass a `schema()` override that does not exist;
  for other ambiguous names the error now names slots and `.inverse()`.

### Kit (`symmetria-kit`)

- `real` and `doublePrecision` defaults preserve negative zero and accept `NaN`
  and both infinities, also inside an array default.
- Migration generation now detects changes to calendar days versus elapsed
  hours, exact JSONB numbers, timestamp microseconds and wall-clock times, and
  non-breaking spaces in array defaults.
- An interval default or CHECK literal with a number that has no unit is
  compared as PostgreSQL reads it: `'1 0:00:00'` is one day, `'90'` is 90
  seconds, `'1:30.5'` is a minute and a half. Changing `'1 0:00:00'` to
  `'0:00:01'` generated no migration. A spelling PostgreSQL refuses is never
  equal to a valid one. `INTERVAL '1 day'` and `'1 day'::interval` are one
  default. A spelling whose meaning depends on the server (`'-1 day 2:00'` under
  `IntervalStyle`, half a microsecond, `'1. day'` before PostgreSQL 16), that
  the comparison does not read (ISO 8601 `P1D`, `1h30m`, a text of more than 200
  characters), or that belongs to a column declared with fields
  (`interval hour to minute`) is compared as written: replacing it by an equal
  one gives a migration that sets the same default, or drops and adds the CHECK
  or index that holds it, once.
- An array default written in SQL is read as PostgreSQL reads it: white space
  after a quoted element adds no element (`'{"a" ,"b"}'` holds two), `'{ }'` is
  empty, `'{ "a" }'` holds `a`. Changing `'{"a" ,"b"}'` to `["a", "", "b"]`
  generated no migration.
- A `Date` used as a `timestamp` default now stores the same UTC wall-clock time
  as an explicit insert, even outside UTC. Timestamp defaults also accept BC
  dates. Generate and apply a migration to update an existing default; changing
  the default does not rewrite existing rows.
- JSON defaults now reject `NaN` and infinities instead of silently storing them
  as JSON `null`.
- **Changed:** a `text`/`varchar` column turned into `timestamptz[]` (or
  `timetz[]`), and a `timestamptz[]` column turned into a string, convert at UTC
  like the other date and time changes, in `up.sql` and `down.sql`. The values
  no longer depend on the time zone of the session that migrates. The generated
  SQL sets the session's zone to UTC around the statement.
- **Changed:** `interval` to `time` (also `interval[]` to `time[]`, and an
  interval declared with fields such as `interval hour to minute`) is a
  destructive change. PostgreSQL keeps the time of day only (`1 day 02:00:00`
  and `26:00:00` both become `02:00:00`) and a rollback cannot restore it.
  `generate` asks for `--allow-destructive`, and the saved SQL carries the
  `-- symmetria: destructive:` note.
- A migration that adds a label to an enum and turns a column of another type
  (text, varchar, another enum) into that enum failed with SQLSTATE 55P04 when a
  row held the new label. So did the rollback of a migration that removed a
  label and turned an enum column into text. **Changed:** such a migration now
  rebuilds the type, as one whose default or CHECK uses the new label does;
  `--online` keeps `ADD VALUE`. Like every rebuild of a type, it fails and rolls
  back while a view, a function or a domain made outside the schema depends on
  the type; drop and recreate that object around the migration.
- `pull` declares a division the way PostgreSQL computes it. A hand-written
  `CHECK (items / 2 = 3)` or index key over integer columns was pulled as
  `divide()`, an exact division, so a database built from the module accepted
  and refused other rows than the original, and the module did not type-check.
  It is now `quotient()`; `divide()` is used only where PostgreSQL divides
  `numeric` or `double precision` values.
- A pulled module type-checks when a column needs `.named()` and has an
  identity, `now()`, `gen_random_uuid()` or `uuidv7()` default: the shortcut is
  written first (`int.auto.byDefault.named("Id")`). Every PascalCase database
  was affected.
- A pulled module loads when a table is named `one`, `maybe`, `many`, `link`,
  `as_number` or `then`: such a table is bound under another name in callbacks,
  and `then` gets the key `thenValue` with `.named("then")`.
- **Changed:** when a column has more than one foreign key, `pull` declares the
  one named `<table>_<column>_fkey`, or else the first by name, and lists every
  other one with its definition. Before, the last by name was declared and the
  others disappeared without a word.
- `pull` declares a `numeric(p,s)` whose scale is above its precision or below
  zero (`numeric(3,5)`, `numeric(5,-2)`, PostgreSQL 15+) as
  `customType<Decimal>("numeric(3,5)", { base: "numeric" })`: its values are
  exact decimal text, as a `numeric()` column's. A module with `numeric(3,5)`
  used to throw on import, and one with a CHECK that computes or compares such a
  column did not type-check. **Changed:** a `numeric(5,-2)` column was
  `customType<string>` before.
- A pulled module loads when a CHECK or index predicate compares a `smallint`
  value with a number outside the smallint range (`CHECK (boxes <= 40000)`,
  `boxes / per_box < 100000`): PostgreSQL accepts such a condition, the DSL
  refuses the number, so the condition is kept as `sql`.
- `pull` now lists what it dropped silently: operator class parameters of an
  index key (`gist_trgm_ops (siglen = 64)`), rules (`rule`), foreign tables
  (`foreign-table`) and table storage parameters (`storage-parameters`).
  **Changed:** a `DEFERRABLE` or `NULLS NOT DISTINCT` multi-column UNIQUE
  constraint is listed with what a database built from the schema loses and
  without the `DROP CONSTRAINT` / `CREATE UNIQUE INDEX` fix, which would have
  made the check immediate (or let NULLs repeat) in the database itself.
- `pull` declares a default with the value PostgreSQL stores when its literal
  has another type than the column: `'ab '::bpchar` on a text column is `"ab"`,
  `'abcdef'::varchar(3)` is `"abc"`; a `numeric(10,2)` literal with fewer
  decimals is written out with them (`'7'::numeric(10,2)` is `"7.00"`, what a
  fresh row holds); a `real` literal on a `double precision` column and a
  `numeric(10,2)` literal with more decimals stay SQL defaults.
- `drift` no longer fails with a `TypeError` on a partitioned table with two or
  more partitions that has a default, an index or a CHECK.
- `testDatabase()` keeps the `options` of the URL it is given (`-c TimeZone=…`)
  and refuses text that is not a URL. The disposable databases of `verify` keep
  the options of `--verify-url` as well.

### Command line (`symmetria`)

- **Changed:** `migrate`, `status`, `rollback`, `verify`, `adopt`, `repair`,
  `drift`, `lint`, `squash`, `discard` and `recover` fail when the directory
  named with `--dir` does not exist, and when neither a config file nor
  `./migrations` is found where the command runs; a mistyped path used to report
  "Database is up to date." In a project whose config is found and whose
  directory does not exist yet, they still exit with 0 and say that `generate`
  creates the first migration (`missingDirectory` in `--json`).
- **Changed:** the CLI gives the database, and the verification server, 30
  seconds to accept a connection (`--connect-timeout <ms>`, 0 disables) and then
  fails with an error naming the server's host and port, instead of waiting for
  the operating system. Ctrl-C before any connection is made exits at once, for
  `verify` too. `verifyMigrations` takes `connectionTimeoutMs` and `onConnect`.
- **Changed:** a database URL must start with `postgres://` or `postgresql://`
  (`--database-url`, `databaseUrl`, `DATABASE_URL`, `--verify-url`,
  `verificationDatabaseUrl`, and `testDatabase({ url })`). Text with the scheme
  forgotten, such as `host:5432/app`, passed the check, and node-postgres then
  connected to localhost instead of the server that was written. Socket
  directories and `postgres:///app?host=/dir` still work. `adopt` checks the
  verification URL before it connects.
- `discard` repairs a latest migration whose directory was deleted by hand also
  when a database is configured; it asks the database's journal directly and
  still refuses a migration that database has applied. It also refuses while
  another process is applying migrations there, with or without `--force`: the
  journal row of a migration that is still running is not visible to other
  sessions, so `discard` used to remove the files of a migration the database
  then listed as applied.
- `recover` removes the staging directory of a generator that was killed before
  it published anything. Ctrl-C or SIGTERM during `generate`, `squash` or
  `discard` leaves no lock (`signal` in the API), and the "already locked" error
  names `symmetria recover`.
- A `.DS_Store` or other dot-file in `migrations/meta/` no longer stops every
  command; another stray entry is named in the error, which also says when one
  of the two files is a directory or a symbolic link.
- The dashboard names a migrations directory that does not exist instead of
  showing "Up to date", and no longer shows parts of a database URL that is not
  one.
- **Changed:** timeout flags and `--steps` take plain digits (`1e3` and `0x10`
  are refused); `rollback --plan` with nothing applied exits with 0; Ctrl-C in
  the schema browser and the profiler exits with 130; Escape closes a typed
  question.
- `symmetria --version` / `-v`. Wrong config values and `--diff` / `--snapshot`
  files are refused with a message naming the file or option. Non-interactive
  `profile` gives up after 10 seconds.

## 3.6.0 — 2026-11-24

Fixes from a bug hunt on 3.5.0 in places no hunt had reached (table search and
embedding providers, the TypeScript types, the command line, Node.js and
behaviour under load), and from two more hunts before release: raw SQL and
quoting, nested writes, differential fuzzing, speed, tenant scopes, write
filters, running migrations, the reference's promises and the better-auth
adapter. Rows read or written outside a `$scope()`, writes that touched more
rows than their filter names, and names from the database that ran as code or
SQL are among them.

### Runtime (`symmetria`)

- Full-text search finds a row by its own words in every language: PostgreSQL
  lowercases the question as it lowercased the document (Turkish `İ` and Greek
  final `Σ` were lowercased by JavaScript's rules and missed). Paths, signed
  numbers and URL queries keep the characters PostgreSQL's parser keeps
  (`/etc/hosts`, `-5`, `./run.sh`, `https://x.org/a?b=1`). Plain ASCII questions
  find every row they found before. A question with a sign, a slash or a URL
  query next to a word may find more rows, and may rank the rows it finds
  differently. Punctuation that PostgreSQL's parser drops (`keys?`, `(account,`,
  `e-mail--`) asks for nothing more than the words, so such a question finds the
  same rows, ranked the same, as before. However long or repetitive a question
  is, the query it sends stays bounded: a word made of more than 16 runs of
  letters and digits is searched by its first run only, and the other spellings
  sent fit in 128 operands and 256 runs of letters and digits.
- **Changed:** a search object, and a write that waits for the model to embed
  its rows, run each time they are awaited, as queries and writes do. A kept
  search sees rows written since and the current `$scope()` tenant; it embeds
  its question once and asks the model again only after a failure. An embedded
  insert awaited twice inserts twice.
- **Changed:** inside `$transaction`, a write that waits for its embedding and a
  search that waits for its question's embedding keep the place in the
  transaction's order they took when they started:
  `Promise.all([tx.chunks.insert(row), tx.chunks.count()])` counts the row, and
  a search started before an insert does not see it. The model is asked at once,
  and the statement runs in a savepoint that holds the transaction's connection
  until the model has answered. So, as with chunked and nested inserts, catching
  a failure of such a write leaves the transaction usable instead of aborting
  it. Each such write or search adds SAVEPOINT and RELEASE statements, and shows
  as a `savepoint` span under OpenTelemetry.
- `missing()` and `reindex()` failed over a meaning source column that is not
  text (an enum, uuid, numeric, a date, a timestamp, jsonb, a boolean, a number,
  a custom type such as ltree, hstore or bytea) with "invalid input value" or
  `invalid input syntax for type timestamp with time zone: ""`, and `reindex()`
  never embedded a row whose value is not a JavaScript string (a timestamp, a
  number). They now read such columns as a query reads them, through their
  codecs, and `reindex()` builds the text as an insert does. `missing()` reads a
  value whose text cannot be empty (a number, a date, uuid, bytes, an array)
  only to see that it is not NULL, and a jsonb document only for its JSON type,
  plus its text when it is a JSON string: over 100,000 documents of 2 KB it
  takes about 14 ms, where `IS NOT NULL` takes 6 ms. `fullText()` reads uuid,
  numeric, inet and time columns through a cast. Text, varchar, char and citext
  columns keep the same stored expression, so no migration follows. A
  `customType()` declared with a text `base` whose own type is not text (ltree,
  hstore, an enum type) is read through its output.
- **Changed:** a meaning embeds a source value that is not a string when the row
  is written, with the text `reindex()` gives it: a number, a bigint or a
  boolean as JavaScript writes it, a `Date` as its ISO text, bytes as `\x…`, an
  array or an object as JSON. Before, such a row was written without an
  embedding. In a json or jsonb column an object or an array is embedded as JSON
  with its keys sorted, so the text does not depend on the order jsonb keeps
  keys in, and a JSON string as the string itself. JSON `null`, and a JSON
  string of only spaces, have no text, as NULL has none. Where PostgreSQL stores
  a value in its own form (a uuid's letter case, a numeric's scale, an inet's
  `/32`, a `Date` in a `date` column), an insert embeds the value as written and
  `reindex()` the value as stored. A number in a `real` column is embedded as
  the column keeps it (`1 / 3` as `0.33333334`), by an insert and `reindex()`
  alike. The elements of a `bytea` or `real` array are embedded as a lone value
  of their type is (a `bytea` array as `["\\x0102"]`, not as JSON objects of
  byte indexes). Since such rows wait for their embedding, `toSQL()` and
  `prepare()` of an `insert()` or `upsert()` now also throw ("cannot wait for
  embeddings") for a table whose meaning reads a column that is not text, such
  as a number or a date; pass the embedding with the rows to get the SQL.
- `reindex()` never wrote the embedding of a row whose source column has a codec
  that changes the stored text (an encrypted or encoded `customType()`): it
  asked the model again on every call, and `missing()` kept counting the row.
  The check that a row did not change while the model answered now compares the
  stored values, so the row is embedded once. A stored value that decodes to
  only spaces is still counted by `missing()`, which decides in SQL.
- `reindex()` never ended over a table whose primary key reads in another form
  than stored: a `timestamptz` with microseconds, a numeric decoded to a number,
  a `customType()` that decodes. It found no row to write, read the same row
  again, and asked the model on every turn. It now finds and pages rows by their
  stored key. Keys read exactly (integers, text, uuid) keep the same SQL.
- **Changed:** `fullText()` refuses an enum, a date, an interval, money, a
  timestamp, a range, a multirange or an array column, in any spelling
  (`timestamp(3) with time zone`, `_text`, `varchar(40)[]`,
  `character varying(10)[]`, `char(3)[]`, an array of a custom type such as
  `citext[]`): PostgreSQL cannot keep their text in a generated column, so the
  migration failed. `search()` over such an array reads its text; it failed with
  `function to_tsvector(…, character varying[]) does not exist`. `bm25()` takes
  only the types pg_search matches words in: text, varchar, citext, json and
  jsonb, and arrays of text or varchar. It refuses every other type of
  PostgreSQL's own, in any spelling: uuid, numeric, inet, time, a date, a
  timestamp, an interval, money, numbers, booleans, bytea, `char(n)`, `name`, a
  tsvector, xml, a range, a multirange, and any other array (`int[]`, `uuid[]`,
  `citext[]`). It also refuses a `customType()` declared with a `base` when its
  own SQL type is not one of those (a domain over text, ltree, hstore). With
  these, the migration failed (char(n), name, tsvector, xml, a multirange,
  bytea), or every search did ("type `_int4` is not compatible with the `|||`
  operator"). A `customType()` without `base` is still accepted.
- `ollama()` reads `OLLAMA_HOST` as the `ollama` command does: without a scheme
  the port is 11434 (`0.0.0.0`, `127.0.0.1` and `localhost` went to port 80),
  and `0.0.0.0` is reached at `127.0.0.1`; a URL (`baseUrl` or `OLLAMA_HOST`
  with a scheme) is used as it is, credentials, port and path included.
- **Changed:** every ready-made embedding model takes `timeoutMs` (60,000 ms,
  one minute, unless given) and `signal`. A service that accepts a request and
  never answers now fails the write or search with an error naming the service,
  instead of holding it, and its transaction, forever. A model that needs longer
  than a minute for a large batch needs a larger `timeoutMs`.
- **Changed:** a row whose embedded text is only whitespace (as JavaScript's
  `\s` counts it, no-break spaces and byte order marks included) gets no
  embedding, as a whitespace-only question finds nothing; `missing()` and
  `reindex()` leave such rows out. To tell, they read each column's first
  character and look further only when it is a space, so they cost less than in
  3.5.0, which built each row's whole text.
- The reference states that a full-text question uses its first 64 distinct
  words.
- A full-text rank or headline (`searchRank()`, `searchHeadline()`, and the
  ranking of `table.search()` by words) parses its question once per statement.
  On Bun, and with `symmetria/pg`'s `prepare: true`, PostgreSQL may run a
  prepared statement with a generic plan from its sixth run. There the question
  was parsed again for every row: a table search for a long question over
  100,000 matching rows went from about 80 ms on its first runs to 1,400 ms; it
  now takes about 200 ms. A match (`search()`) still parses the question in
  place, so the planner sees it.
- **Changed:** a `stream()` outside a transaction ends its transaction and gives
  its connection back once its reader has asked for no row for `idleTimeoutMs`
  (default 60000 ms, one minute) while other queries wait for one of the pool's
  connections. Reading on then fails with "this stream was ended because its
  reader asked for no row …". Before, an iterator read partly and dropped
  without `return()` kept its connection until garbage collection, which Node.js
  may not run for a long time in a quiet process: the pool starved and `close()`
  hung. While no query waits, a reader may pause as long as it likes.
  `stream({ idleTimeoutMs })` sets a shorter or longer time, or `Infinity`.
- **Changed:** `driver.close()`, and so `testDatabase().close()`, ends the
  transactions of open streams instead of waiting for their loops, as `$close()`
  does.
- **Changed:** `$close()` refuses new work from the moment it is called. Before,
  a query or a stream started while it ended the open streams still ran, and
  such a stream kept `$close()` waiting for its whole loop.
- A `stream()` loop inside an async helper no longer counts its connection as
  held by the helper's caller. The caller's queries were refused ("…would wait
  forever") although they would only have waited their turn; they now wait while
  the loop goes on, however long its fetches take. A query from a `for await`
  body that would wait for the loop's connection is still refused at once. A
  query from code that reads a stream another way (`ReadableStream.from()`,
  `Readable.from()`, an async generator over it, `next()` by hand), while the
  streams it started hold every connection, is refused once all of them have
  waited a second for their reader to ask for the next row. The same applies to
  a helper whose loop body spends longer than a second on a row before asking
  for the next one. A stream's iterator is still an async generator, so
  `await using` closes it.
- **Changed:** `count()` and `exists()` of a source with `forUpdate`/`forShare`
  lock every row it selects, as the query, `first()` and `aggregate()` do,
  including `of`, `noWait` and `skipLocked`; with `skipLocked`, `count()` counts
  the rows it could lock. Before, they took no locks. A locking `count()`,
  `exists()` or `aggregate()` keeps the source's ordering, the order its rows
  are locked in. In `$batch()`, these reads of a locking source are refused like
  the locking query itself; before, `aggregate()` joined the batch with its lock
  and `count()`/`exists()` joined without one.
- **Changed:** "too many connections" (SQLSTATE 53300) is a `ConnectionError`
  (`kind: "connection"`) on both drivers, because the connection could not be
  opened and a later attempt may get a slot. It was a `QueryError` of kind
  `other`.
- A `customType("x")` declared without options (or with `null`), which plain
  JavaScript can write, reads and writes values as any column of that SQL type
  does. Every query that bound a value to it failed with "codec.encode is not a
  function".
- A `customType()` declared with another name of a 64-bit or decimal type
  (`int8`, `BIGINT`, `bigserial`, `decimal(30,10)`, `NUMERIC(30,10)`,
  `dec(30,10)`, `int8[]`, or an array type name such as `_int8` or `_numeric`)
  kept its precision only at the top level: nested results, `$batch()` and
  DISTINCT nested objects read it as a JSON number, so 9007199254740993 came
  back as 9007199254740992, and `dec(30,10)` read
  12345678901234567890.1234567891 as 12345678901234567000. Every spelling
  PostgreSQL accepts is now known, `char varying(n)`, `bit varying(n)` and the
  other array type names (`_bool`, `_uuid`, `_date`, `_timestamptz` …) included.
- `searchDocument()` and a column's `search()`, `searchRank()` and
  `searchHeadline()` failed in queries over columns that are not text (an enum,
  uuid, date, numeric, inet, timestamp, boolean or bigint column), with "invalid
  input value" or "function to_tsvector(…) does not exist", and
  `searchDocument()` failed over a jsonb column or a JSON path with "invalid
  input syntax for type json". They now read such a value as its text, as table
  search does. A JSON value is read by its string values, as PostgreSQL's
  full-text functions read it and as `search()` read a jsonb column before: its
  keys, numbers and booleans are no words, and an index on
  `to_tsvector(cfg, column)` still serves the match. Text and JSON values render
  the same SQL as before in `search()`, `searchRank()` and `searchHeadline()`. A
  `customType()` is read as its `base` (new, see below). One declared without a
  `base`, as every schema written for 3.5.0 is, is read as it is, as before,
  since a domain may be text or JSON: `search()`, `searchRank()` and
  `searchHeadline()` read a domain over jsonb by its string values, and an index
  on `to_tsvector(cfg, column)` still serves them; `searchDocument()` and
  `fullText()` over such a domain still fail ("invalid input syntax for type
  json") until the column declares `base: "jsonb"`.
- `minimum()` and `maximum()` of a `customType("bool")`, `"BOOLEAN"` or
  `"UUID"`, and of range types, failed with "function max(…) does not exist".
- `customType(sqlType, { base })` states the type a domain stands for:
  `customType<Decimal>("amount", { base: "numeric(30,10)" })` reads and writes
  as `numeric(30, 10)` does, everywhere, and `{ base: "timestamptz" }` reads
  `Date`s in nested results too. With `encode` and `decode`, `decode` receives
  the base type's value. The base is not part of the DDL. Searches read such a
  column as its base too: `search()`, `searchDocument()` and `fullText()` read a
  domain over uuid through a cast, and treat one over a date as a date.
- A vector distance in a CHECK or a partial index's `where()`
  (`embedding.l2Distance([…]).below(0.5)`) failed at migrate with "cannot use
  subquery in check constraint" since 3.4.1. DDL writes the vector as 3.4.0 did,
  so pull and drift agree.
- `searchDocument()` in an index over a jsonb column or JSON path failed to
  migrate ("invalid input syntax for type json"), and so did a `fullText()`
  search over a jsonb or integer column. The index now reads each part as the
  query reads it: JSON as `coalesce(…, '{}')`, a type known not to be text (one
  of PostgreSQL's own, an enum, a customType's base) as `(part)::text`, a custom
  type without a base as it is. So it migrates and serves the query.
- **Changed:** an index on `searchDocument()` refuses, when the schema is
  declared, a part whose text PostgreSQL cannot index: an enum, a date, an
  interval, money, a timestamp, a range, a multirange or an array, or a
  customType whose base is one of them. Such an index failed at migrate
  ("functions in index expression must be marked IMMUTABLE"; in 3.5.0 "invalid
  input value"). Queries and checks still read those columns as text. A
  `customType()` without `base` cannot be checked (a domain over a date, an enum
  type, ltree); declare its `base`.
- On Node.js with symmetria/pg, a `bytea` value was a view into Node's shared 8
  KB buffer pool: its `.buffer` held other queries' SQL, parameters and rows. It
  now owns its bytes.
- A query called with no arguments, as `node:assert`'s `rejects()` and
  `doesNotReject()` call it, runs and returns its promise, instead of throwing
  "a shape requires a synchronous callback".
- A prepared `jsonb(schema)` parameter can be written into its column. A
  prepared `bigint` parameter takes a safe integer. An `int` parameter compares
  with a bigint column and looks up a bigint key.
- **Changed:** the types refuse inserts, upserts, updates, deletes, table search
  and `$transaction()` on the `$batch()` handle, and `upsert({ by })` and
  `onConflict()` columns that belong to no primary or unique key. The runtime
  already refused the writes, `$transaction()` and such key columns. A table
  search on the `$batch()` handle still runs at runtime, as its own statement
  outside the batch's single snapshot; run it outside `$batch()`.
- Docs: the `pull` example in the reference now declares the `tags` table that
  its junction table points to.
- A scoped table joined into a query of another database keeps its scope.
  `db.posts((post, { innerJoin }) => … innerJoin(tenant.users, …))`,
  `crossJoin(tenant.users)` and `leftJoin(tenant.users.as("author"), …)`, also
  inside `$batch` and `$transaction`, read only the tenant's users. Before, the
  JOIN carried only the scope of the query's own database, so another tenant's
  rows were read. A narrower `tenant.$scope({ users: … }).users` joined into a
  `tenant` query now adds its condition too.
- **Changed:** a query with its own fields or options used as a join source is
  refused: `db.users({ where })`, `db.users({ limit })`, `db.users(shape)`
  without `.as()`, `db.users.byId(1)`. Before, its filter, limit and fields were
  silently dropped. The types already refused this. Name a query with selected
  fields with `.as("name")` to join it as a derived table.
- **Changed:** `$scope()` reads each table's callback as a property. A class
  instance whose methods are named after the tables (called with the instance as
  `this`), an inherited property or a non-enumerable property now scopes its
  table. Before, such a scope silently filtered nothing. A `Map`, `Set`, array,
  function, promise or missing argument is refused with a clear error instead of
  being ignored.
- Tables named like a member of every object, such as `toString` or `valueOf`,
  can be queried. Before, every query on them failed with "expected a SQL
  predicate".
- **Changed:** a `$scope()` filter that holds for every row is refused, both at
  `$scope()` and at each execution. Examples:
  `(post) => and(tenant && post.tenantId.is(tenant))` without a tenant, `and()`,
  `isNot(null)` of a NOT NULL column. Reads, writes, counts, streams, batches
  and prepared statements through such a database reject with
  `the $scope() filter of "posts" holds for every row …`, and nothing is read or
  written. Before, they read and wrote every tenant's rows. A narrower scope
  that adds nothing to the scope it narrows is still accepted. In a scope, an
  emptied list is a condition: `notIn(blocked)` with nobody blocked,
  `contains([])`, `contains({})` and `not(overlaps([]))` are accepted there, as
  in 3.5.0. The check refuses a scope whose conditions were all skipped, and one
  that holds for every row by itself: a condition together with its opposite,
  `isNot(null)` of a NOT NULL column, `like()` of only `%` of a NOT NULL column
  (text, or a uuid, date, timestamp or enum). It does not catch a missing tenant
  beside another real condition
  (`and(tenant && post.tenantId.is(tenant), post.deleted.is(false))`).
- **Changed:** the inverse collection of a condition `.one()` relation follows
  the same first-match rule as the relation itself. `user.reviewed` lists a post
  only under the user the post resolves to: the first matching user by primary
  key, among those the scope admits. This holds in nested collections, `count()`
  and other aggregates, `some()`/`none()`/`every()`, join helpers and write
  filters. Before, a post was listed and counted under every matching user, so
  `users.delete({ where: (user) => user.reviewed.some() })` also deleted users
  that no post resolves to. Like the relation itself, its inverse now needs a
  primary key on the target table. Foreign-key relations and `.many()` condition
  relations are unchanged.
- A write whose `where()`, `doUpdate(…, { where })`, SET values or `returning()`
  builds a subquery over its own table from the same handle
  (`db.comments.delete().where((comment) => notExists(db.comments(…, { where: (reply) => reply.parentId.is(comment.id) })))`,
  or `tx` in both places inside a transaction) compares the subquery's rows with
  the written row again. Before, the link was lost: "delete the comments nobody
  replied to" deleted every comment, the `exists()` form wrote nothing, and such
  a SET value was computed from the wrong row.
- **Changed:** a prepared UPDATE or DELETE checks its filter again with the
  values of each execution, and refuses values that make it hold for every row,
  as the same filter written with those values is refused. Examples: `isNot(p)`
  or `isDistinctFrom(p)` of a NOT NULL column with `p` bound to null,
  `count().atLeast(p)` with 0, `count().isNot(p)` with -1,
  `notIn(query, { limit: p })` with 0, `contains(p)` with `[]`. Before, these
  wrote every row. It compares parameters by the values they bind, inside
  subqueries, relation quantifiers and groups too: a condition and its opposite
  written with two parameters (`or(active.is(a), active.is(b))` bound to `true`
  and `false`; with equal values `or(status.is(a), status.isNot(b))`,
  `or(posts.some((post) => post.views.is(a)), posts.none((post) => post.views.is(b)))`,
  `exists()` beside `notExists()` of such subqueries,
  `or(count().is(a), count().isNot(b))`) is refused too, and a nullable
  parameter bound to null counts as `is(null)` there, as written out. It
  re-checks at each execution only the parts its values can decide; a filter
  that no values, null included, can make hold for every row (an `or()` of
  windows `and(at.above(p), at.below(q))`, `or(id.is(a), age.is(b))` or
  `posts.some((post) => post.views.isNot(b))` with `b` nullable) is not checked
  again, and its executions cost what they did in 3.5.0. With 1,000 `isNot(p)`
  of nullable parameters, an execution's client-side work is about 3 to 4 times
  what binding them cost in 3.5.0.
- **Changed:** the every-row guard of UPDATE and DELETE also refuses:
  `contains()` of an empty list or object (`tags.contains([])`,
  `meta.contains({})`, a JSON path's `contains([])`) and `like()`/`ilike()` of a
  pattern of only `%` (`like(prefix + "%")` with an empty prefix), written out
  or bound to a parameter, like `notIn([])` — they match every row that holds a
  value, and the message says so and points to `isNot(null)` or `.all()`;
  `not(overlaps([]))`; `not(between(5, 1))` of a NOT NULL number column; a
  condition together with its opposite in an `or()` (the condition and its
  `not()`, or two methods that say the opposite of each other: `is` and `isNot`,
  `in` and `notIn`, `atLeast` and `below`, `atMost` and `above`, `some()` and
  `none()`, `exists()` and `notExists()`), comparing the same thing where
  neither side can be NULL. On NOT NULL columns:
  `or(flag.is(true), flag.is(false))`, `or(id.notIn([2]), id.is(2))`,
  `or(not(id.in([1, 2])), id.in([2, 1]))`, a list with a value written twice,
  `or(name.atLeast("m"), name.below("m"))`,
  `or(name.like("a%"), not(name.like("a%")))`, and a column compared with
  another (`or(a.is(b), a.isNot(b))`, `or(a.atLeast(b), a.below(b))`). On any
  column: `or(x.is(null), x.isNot(null))` (also on a NOT NULL jsonb column),
  `or(user.posts.some(), user.posts.none())`, a `count()` compared both ways,
  and pairs with `isDistinctFrom()` (`or(id.isDistinctFrom(2), id.is(2))`, also
  on a jsonb or JSON path operand or an expression such as `id.plus(1)`;
  `or(meta.isDistinctFrom(null), meta.is(null))` in either order), which hold
  where the value is NULL or JSON null too. Also refused: comparisons of one
  number column with numbers that together admit every value
  (`or(id.atLeast(5), id.below(6))`, `or(id.below(5), id.is(5), id.above(5))`,
  `or(id.isNot(5), id.atLeast(5))`, `or(id.isNot(1), id.isNot(2))` of a NOT NULL
  column, `or(x.is(null), x.above(0), x.atMost(0))`, `between()` as one piece, a
  group of conditions of that column, a group below `not()` read by De Morgan);
  `length()` of a NOT NULL array compared with what every length passes;
  `isNot(null)` of a `coalesce()` with a value that is never NULL; and, inside a
  subquery, a NOT NULL column of the subquery's own table now counts as never
  NULL. The check looks for these forms and is no proof. Other filters that hold
  for every row are written as given: a part it cannot tell is never NULL
  (arithmetic such as `or(id.plus(1).atLeast(5), id.plus(1).below(5))`, a
  relation path such as `post.author.name`, other SQL in a template), numbers
  written as different text (`or(balance.is("5"), balance.isNot("5.0"))` of a
  numeric column), and ranges of text or dates with different bounds
  (`or(name.atLeast("m"), name.below("n"))`). Building an UPDATE or DELETE takes
  1.1 to 2 times as long as in 3.5.0 for long filters (an `and()` of 30 `or()`s,
  an `or()` of 30 `and()`s, a 3,000-value `in()` beside a `notIn()`, an `and()`
  of 1,000 `isNot()` of one column), about 1.5 times for 200 small updates (up
  to 1.9 times in some runs), 1.8 to 2.6 times for an `or()` of 64 comparisons
  of one or two columns, and 1.3 to 2.4 times for filters nested 50 to 1,000
  levels deep (`where = or(where, …)` built step by step, chains of
  `not(or(…, not(and(…))))`): the time grows in step with the depth, and 1,000
  levels build in 3 to 6 ms.
- **Changed:** a condition interpolated alone into `sql<boolean>`
  (``sql<boolean>`${post.id.notIn([])}` ``) is checked as that condition, also
  in parentheses or followed by `= true` or `IS TRUE`
  (``sql<boolean>`(${…})` ``; `IS TRUE` is read as the condition with NULL as
  FALSE, so below a `not()` it holds where the condition is NULL): a write
  filter or a `$scope()` filter that holds for every row is refused in this form
  too. Other SQL around it keeps the template opaque.
- **Changed:** an upsert split into several statements compares keys under the
  column's collation: with a case-insensitive `text.collate(…)` column, "Alpha"
  and "ALPHA" are refused as one key (`SYMMETRIA_DUPLICATE_CONFLICT_KEY`).
  Before, the later row silently overwrote the earlier one.
- An upsert split into several statements and keyed by an array column
  (`text.array.unique`, `timestamptz.array.unique`, …) no longer fails with
  "malformed array literal".
- A `sql` fragment cannot reach into the SQL Symmetria writes after it. A
  fragment ending in a `--` comment gets a line break after it. Before, the
  comment swallowed the field's ` AS "key"` (the field was missing from the
  rows), an ORDER BY's ` DESC`, the next `SET` assignment, or the `$scope()`
  check of a write's RETURNING (rows were written outside the scope). Fragments
  without a comment are written as before.
- **Changed:** a `sql` template that leaves a `/*` comment, a `'…'` string, a
  `"…"` quoted name or a dollar-quoted string open is refused when it is built.
  A value interpolated inside a comment or quoted text, where PostgreSQL reads
  no parameter, is refused when the query compiles; before, node-postgres failed
  with "bind message supplies … parameters" as a ConnectionError. Write
  `'%' || ${term} || '%'` instead of `'%${term}%'`. Fragments are read as
  PostgreSQL reads them with `standard_conforming_strings` on, so with it off a
  `\'` in a plain string must be written `''`.
- A condition interpolated into `sql` (`${post.title.is("a")}`, `exists()`,
  `and()`) is written as its SQL in parentheses, and an ordering
  (`${post.views.descending}`) as its SQL with the direction. Both were bound as
  the JSON text `{}`.
- **Changed:** `sql` refuses to interpolate a query (interpolate
  `query.scalar()` or `exists(query)` instead), a function, a Map, a Set, a
  class instance or an array that holds a column. Before, these were bound as
  `{}`, or as the instance's own fields, or failed with "DataCloneError". A
  condition, ordering or query passed as a value elsewhere (`column.is(…)`, an
  insert) is refused the same way. A value that cannot be copied names itself
  instead of failing with "DataCloneError".
- **Changed:** a `sql` template with an escape that JavaScript reads as no text
  (`\u` without hex digits, `\x`, `\1`, a Windows path such as `'C:\users'`) is
  refused with the escape named. Before, queries failed with an internal
  TypeError, and a default became empty SQL ("invalid migration snapshot").
  Write `\\` for a backslash.
- A result key longer than 63 bytes (such as 22 Japanese characters) works at
  the top level, nested, in `$batch`, `returning()`, `page()`, `stream()`,
  `.as()` and CTEs. It is selected under an alias made of its first bytes and a
  hash, and comes back under the key; before, it was refused as too long. Keys
  that fit are written as before, so page cursors stay valid.
- A nested relation or `$batch` field named `__symmetria_row` returns its rows;
  the relation came back as `[{}]`, and a one-to-one failed. A `returning()`
  field named `__symmetria_scope` keeps its value in a scoped write. A field
  named `__symmetria_order_0` no longer clashes with the order columns of an
  IVFFlat nearest search. Page cursors issued before stay valid.
- Nested-object keys with a backslash are written as `E'…'` literals, which read
  the same with `standard_conforming_strings` off. With it off, such a key ended
  its literal early, and a crafted key ran SQL of its choosing. Page cursors
  issued before for such queries stay valid.
- `where: { constructor: … }`, and another name every object has, is refused as
  naming no column (the error called it a relation). A field named `$1` is
  refused with an error saying that names starting with `$` are reserved.
- The reference states that `ConnectionError` covers SQLSTATE class 08, 08P01
  `protocol_violation` included. It also states that a `sql` fragment without
  `.of` comes back as the driver parses it (Bun can return an `int4[]` as
  `Int32Array`; `sql.of(int.array)` returns an array).
- **Changed:** a `sql` default, check or index expression ending in a `--`
  comment is stored in the snapshot with a line break after it. CREATE TABLE
  with such an expression failed before. Snapshots saved without the line break
  need no migration. A default set by `ALTER … SET DEFAULT` and an index
  `where()` ending in a comment, which ran before, no longer show as drift in
  `drift`, `verify`, `adopt` and `repair`, and a later migration that restores
  one of them ends the comment with a line break: before, the comment took in
  the semicolon and the statement after it.
- **Changed:** on a NOT NULL `jsonb` column, a stored JSON `null` (what a JS
  `null` is written as) now counts as null in every comparison, as on a nullable
  column or a JSON path. `isNot(x)`, `notIn([x])`, `not(is(x))`, `not(in([…]))`
  and `above()`/`below()`/`atLeast()`/`atMost()` leave it out, and
  `isDistinctFrom(null)` no longer holds for it.
  `delete({ where: (row) => row.meta.isNot(0) })` no longer deletes rows that
  hold JSON null, and an update filtered by `meta.isDistinctFrom(null)` is no
  longer refused as a write to every row. These comparisons keep the column
  bare, so its indexes serve them, and add constant-NULL parts that make JSON
  null answer NULL wherever the comparison stands, also inside a `sql` template,
  below a NOT written in it, or in a selected `sql<boolean>`
  (`("meta" > $1 OR ("meta" = 'null'::jsonb AND NULL))`,
  `("meta" < $1 AND ("meta" <> 'null'::jsonb OR NULL))`). A `between()` on a
  jsonb column or path whose bound is a prepared parameter, a column or `[]` is
  written the same way. `is()`, `in([…])`, `between()` and `contains()` of a
  jsonb column (NOT NULL or nullable) or of a JSON path get the same
  constant-NULL part (`("meta" = $1 OR ("meta" = 'null'::jsonb AND NULL))`):
  JSON null answers NULL there instead of FALSE, so
  ``sql<boolean>`NOT ${meta.is(3)}` `` leaves it out as `not(meta.is(3))` does,
  and a selected ``sql<boolean>`${meta.is(3)}` `` reads null for it. `is(p)`
  with a prepared parameter bound to JSON null still finds JSON null; `in()` of
  a subquery is written as before. In a filter PostgreSQL drops the constant
  NULL, so a btree or GIN index and a partial index declared with the same
  condition serve them, as in 3.5.0 (custom and generic plans, PostgreSQL 16 and
  18); `not()` of them is a plain NOT. `isDistinctFrom()` of a jsonb column or
  path reads JSON null as null on both sides: two JSON nulls are not distinct,
  and a prepared parameter bound to null (JSON null, or SQL NULL for a
  `.nullable` one) is `isDistinctFrom(null)`, for the rows and for the every-row
  check of a prepared UPDATE or DELETE. Schema DDL and page cursors keep both
  sides bare, as in 3.5.0.
- `between()` on a JSON value no longer finds JSON null when the lower bound is
  an empty array (`between([], [1, 2])`), which jsonb sorts below null. A
  prepared or column lower bound treats JSON null as null as well.
- **Changed:** `notIn(subquery)` on a JSON value leaves out JSON null, as
  `notIn([…])` already did.
- `not()` of `is()`, `in([…])`, `between()` or `contains()` of a JSON column or
  path no longer runs the comparison a second time: it is a plain NOT, which
  PostgreSQL reads as `"meta" <> $1 AND "meta" <> 'null'::jsonb`; of another
  JSON value (a `coalesce()`, say) it checks the value's JSON type. On a JSON
  path the negation takes about 1.5 times the server time of the plain negation
  3.4.1 sent.
- These JSON changes leave CHECK constraints and partial indexes made by earlier
  releases unchanged, and page cursors issued before stay valid.
- A value compared with a `timestamptz(n)`, `timestamp(n)`, `time(n)`,
  `timetz(n)`, interval-with-fields, `bit(n)`, `varbit(n)`, plain `bit` or plain
  `char` column, or searched in an array of one, is no longer rounded or cut to
  the column's precision first: a delete whose filter asked whether a
  `timestamptz(0)[]` column contains 12:00:00.400 deleted the row holding
  12:00:00. Casts of bound values name the type without its modifier, as they
  already did for `varchar(n)`, `char(n)` and `numeric(p,s)`. The column still
  rounds what is written, and page cursors issued before stay valid. A prepared
  value selected as `timestamptz(n)` is returned as given, not rounded. This
  holds for every spelling of these types, `pg_catalog.bit(n)`,
  `pg_catalog.bpchar(n)` and quoted names such as `"varchar"(n)` included.
- A prepared `.nullable` value compared with `is()`/`isNot()` on a column whose
  type is not PostgreSQL's own (a domain, an enum, `citext`) takes its type from
  the comparison, as a literal does, whether or not its `customType()` declares
  a `base`. A `numeric(30,10)` domain rounded the value first (a prepared delete
  removed a row that did not equal it), a `varchar(5)` domain failed with "value
  too long", and a domain's CHECK refused values no row holds.
- **Changed:** writing an element too long for a `bit(n)`, `varbit(n)`, plain
  `bit` (`bit(1)`) or plain `char` (`char(1)`) array column, also when the type
  is spelled `pg_catalog.bit(n)`, `pg_catalog.bpchar(n)` or `"bit"(n)`, now
  fails with PostgreSQL's length error instead of being cut, as `varchar(n)` and
  `char(n)` arrays already did, in inserts, updates and upserts.
- On Bun, when the database, role or pooler prints `bytea` in the escape form, a
  bytea read fails with an error that says to pass
  `postgres({ url, connection: { bytea_output: "hex" } })`, instead of Bun's
  "Failed to read data". The error is still Bun's own, with its class and `code`
  (`ERR_POSTGRES_UNSUPPORTED_BYTEA_FORMAT`); only its message changed. The
  reference no longer says Bun reads that form at the top level.
- **Changed:** when a custom `executor` or driver returns a result that does not
  say how many rows a write without `returning()` changed (a plain array of
  rows), the write now fails after it ran, with an error asking for
  `{ rows, affectedRows }`. It used to resolve `{ affectedRows: 0 }`. A
  node-postgres result (`rowCount`) and an array with `count` (Bun.SQL,
  postgres.js) are read as they are; a node-postgres result passed whole used to
  report `affectedRows: undefined`.
- OpenTelemetry: a read of a CTE is named after the table the CTE reads
  (`SELECT posts`, `db.collection.name` posts) instead of `WITH ranked_posts`,
  also inside a subquery and under `EXPLAIN`. CTE names are matched as
  PostgreSQL matches them (an unquoted name in any case), and a recursive CTE
  that reads only itself names no table. A statement after a `WITH` list is
  named by its own operation (`SELECT` for
  `WITH … (SELECT …) UNION (SELECT …)`). A `$batch()` statement is named after
  the table of its first subquery (`count()`, `exists()` and `aggregate()` reads
  come before other reads), and a stream over a CTE after the table the CTE
  reads; so is a raw statement made only of subqueries, whatever its aliases
  (`SELECT (SELECT count(*) FROM users) AS m`). Comments and strings are never
  read as SQL: `-- note` before a statement no longer makes it `QUERY`, and a
  `FROM` inside a comment no longer names the table. Other statements without a
  table of their own (`SELECT 1 WHERE EXISTS (…)`,
  `(SELECT …) UNION (SELECT …)`) carry no table name, as before.
- Naming an OpenTelemetry span takes time in proportion to the statement's
  length. In 3.5.0, a statement with derived tables nested 10,000 deep (180 KB)
  took over a second to name, and at 900 KB naming failed the query with a stack
  overflow before it was sent.
- **Changed:** NaN, Infinity and -Infinity anywhere inside a value (also what a
  nested `toJSON(key)` returns) bound for a json or jsonb column, path or
  prepared parameter fail the query before it is sent. Before, `JSON.stringify`
  wrote them as `null`: an insert stored JSON null, and `is(Number.NaN)` found
  the JSON-null rows. The check walks a value only when its JSON text holds a
  `null`, so encoding such a value takes up to about 1.5 times as long as in
  3.5.0, and other values cost what they did.
- **Changed:** JSON `has()` and `overlaps()` are NULL for a document that is SQL
  NULL or JSON null, as `= ANY()` of a NULL array is. `not(doc.has(1))` no
  longer holds for those rows, in reads and writes alike. They, and JSON
  `length()`, are NULL for an object or a scalar too, which failed the query
  ("cannot extract elements from an object") whenever PostgreSQL evaluated them,
  also inside an `or()` whose other side already decided the row. Page cursors
  issued before stay valid. A JSON path's `length()` reads the path twice, so in
  a filter over many rows it takes up to 1.5 times as long in PostgreSQL.
- On Bun, a transaction connection whose ROLLBACK failed with a server error
  went back to the pool; it is now closed, as with node-postgres.
- **Changed:** on node-postgres, a write to a closed socket (`EPIPE`), or any
  other failed socket call (`EBADF`, `EPERM`, …), is a `ConnectionError`
  (`databaseError()` gives kind `connection` and SQLSTATE 08006), like other
  lost connections. It was a plain `QueryError` whose `sqlState` read `EPIPE`: a
  migration error showed "SQLSTATE EPIPE", and OpenTelemetry spans reported it
  as the database status code.
- `in()` / `notIn()` given a prepared parameter, a column or a single value said
  "a subquery requires selected fields". It now says it takes an array or a
  single-column subquery, and that a prepared list has one parameter per item.
- Nested inserts store foreign keys exactly as PostgreSQL holds the parent's
  key. A `timestamptz` key keeps its microseconds, so a child no longer silently
  points at another parent whose key is the same value cut to milliseconds. A
  parent keyed by a `now()` default can take nested children. A `customType()`,
  numeric, interval or time key is no longer decoded and encoded again. This
  holds for connected, created and upserted rows and for junction rows, and in
  every session: dates and timestamps are copied in ISO form whatever the
  `DateStyle` and time zone, also inside an array, a range or a multirange of
  them (`timestamptz.array`, `tstzrange`, an array of such ranges), and doubles
  with all their digits whatever `extra_float_digits`; a `customType()` over one
  of these types does the same when it declares its `base`.
- Several `connectOrCreate` entries of one relation are resolved in the key
  order the docs promise for every key type: `customType()` values by their
  encoded value, Dates by time, bigints and numeric text by value, composite
  keys column by column. Concurrent inserts that name the same rows in opposite
  orders no longer deadlock. Rows created this way get their generated ids in
  key order.
- A one-to-one `connectOrCreate` no longer looks the row up by the new parent's
  own foreign key, which made it fail with a unique violation instead of
  connecting the existing row. A key holding the parent's foreign key is used
  only when the payload has no other key.
- A row of a nested insert can connect a row written earlier in the same
  multi-row INSERT, such as a reply to the comment before it. That INSERT is
  written first instead of the connect failing with
  `SYMMETRIA_RECORD_NOT_FOUND`.
- A `connectOrCreate` payload that carries a relation field leaves it out, as
  documented, instead of failing with "…onConflict is not a function" when the
  row is new.
- Nested inserts that connect several rows by one column whose value as read is
  not the value stored (a `timestamptz` with microseconds, numeric, interval,
  citext, a `customType()`) link each child to the row PostgreSQL compares equal
  to the value given. Two parents stored at `12:00:00.123` and `12:00:00.123456`
  read as the same `Date`, and a child connected by
  `new Date("…T12:00:00.123Z")` could be linked to the `.123456` parent. This
  also holds for a unique column that no foreign key references. PostgreSQL
  compares the values with the table in one join; 1,000 such connects take 1.1
  to 1.6 times as long as in 3.5.0.
- `connect` accepts a key value that is an object in JavaScript. `connect: date`
  on a `timestamptz` primary key, and a `Uint8Array` or `Buffer` on a `bytea`
  primary key, were refused with "requires a complete non-null unique key". An
  object whose fields are a unique key of the target is still read as a key
  object.
- The children a one-to-many relation's `connect` and `connectOrCreate` entries
  name are all found (or created) first, then moved to the new parent together,
  in primary-key order, whichever key or operation names them. Two inserts that
  moved the same rows could deadlock when they named them in opposite orders, by
  different keys (`connect: [1, 2]` and
  `connectOrCreate: [{ code: "x" }, { code: "y" }]` for the same rows), or with
  `connect` and `connectOrCreate` in one insert. The rows are moved where the
  relation's last `connect` or `connectOrCreate` stands, so a `create` given
  between two of them is written before the rows the first one names are moved.

### better-auth (`symmetria/better-auth`)

- `npx auth generate` keeps the single-field indexes a plugin declares on its
  table, so device-authorization's `deviceCode` and `userCode` are unique.
  Without them two pending devices could get the same user code, and approving
  it could authorise the other device. Regenerate the module and generate a
  migration; it adds two unique constraints (delete duplicate stored codes
  first).
- **Changed:** every reference better-auth declares becomes a foreign key with
  better-auth's delete action. A key that does not end in `Id` (`requestedBy`)
  becomes the relation `requestedBy` with the key column `requestedById` under
  its own SQL name (`requested_by`); a reference to another field uses
  `.by("email")`; `"no action"` is `.onDelete.noAction`; `"set default"` sets
  NULL (better-auth gives the key no default): `.setNull` on an optional key, NO
  ACTION on a required one. After regenerating, the migration adds the foreign
  key and its index; rows pointing at deleted rows must be removed first.
  Application code reads such a key as `requestedById`. A table with two
  references to one table names their reverse sides (`sessionByUser`). The
  adapter still works with modules written by 3.5.0.
- **Changed:** a field name given to better-auth is written as `.named()`
  (`.column()` for a key) whenever it differs from the key, and names the column
  under either casing. The default casing produces the same SQL as before. Under
  `casing: "preserve"`, `email_verified` now names the column (it was
  `emailVerified`); `generate` asks for rename hints rather than dropping the
  column. `authSchemaSource()` takes a `casing` option; `createSchema` reads it
  from the database's schema.
- A model name that is not a JavaScript name (`auth-user`, `default`) gives a
  module that loads: the table keeps its key (`"auth-user": authUser` in
  `authTables`).
- `npx auth generate` refuses, naming both fields, a reference whose relation
  would have the same name as another field of its table (the module had two
  properties with the same name).
- **Changed:** `incrementOne` changes exactly one row, as better-auth's SQL
  adapters do, and only while its filter still holds for that row. A NULL
  counter counts from 0.
- A number for a string field is compared as text on Bun as on node-postgres
  (`listUsers` with `filterValue: 1984` found no users on Bun). "true"/"false"
  in a list for a boolean field are compared as booleans.
- **Changed:** a where value of `undefined` (`filterField` without
  `filterValue`) matches no row instead of throwing, as in better-auth's Kysely
  adapter, for `ne` too. Ordering and pattern comparisons with `null` match no
  row, `null` in an `in` list matches nothing, and a `not_in` list containing
  `null` matches no row.
- `findOne` and `findMany` return only the fields better-auth selects.
- **Changed:** a field better-auth declares as a number but stores in a `bigint`
  column (`rateLimit.lastRequest`) comes back as a number when it is a safe
  integer, and as a `bigint` otherwise.
- An update or delete through the adapter whose filter holds for every row is
  refused with advice a better-auth user can follow, instead of the `.all()`
  advice.

### Kit (`symmetria-kit`)

- Ctrl-C or SIGTERM during `migrate`, `rollback` or another database command in
  a terminal cancels the running statement and waits up to five seconds for its
  rollback before exiting with 130 or 143. Before, the spinner exited at once
  and the server kept the statement, its ACCESS EXCLUSIVE lock and the migration
  lock. A second Ctrl-C exits at once. When the server does not answer within
  the five seconds, the CLI exits anyway and says whether a statement may still
  be running (with `--json`, in the JSON error on stdout).
- **Changed:** Ctrl-C at a CLI question (the rollback confirmation, the typed
  database name, a rename question, the dashboard menu) exits with 130 and rolls
  nothing back. Before, the rollback menu exited with 0, the typed-name prompt
  with 1 ("Aborted with Ctrl+C"), and the dashboard menu with 0. Escape still
  closes the question without the 130.
- `symmetria profile`, the dashboard and command output on a terminal no longer
  write escape sequences, control characters or bidirectional overrides from the
  database (errors, names, stored values); only the CLI's own colours are
  written. Errors on stderr, a migration's DETAIL included, are filtered too.
  Piped output is unchanged.
- **Changed:** `pull` declares a column of a domain type with its base type,
  `customType<Decimal>("amount", { base: "numeric(30,10)" })`, so a domain over
  bigint reads `bigint`, over numeric a decimal string, over timestamptz a
  `Date`, also nested and in `$batch`. A domain over a domain takes the
  innermost base; a domain over a type without a builder (`json`, `oid`) is
  declared like a column of that type (`unknown`, `asNumber()`).
- `graph` / `renderMermaid()` write valid Mermaid for column names with spaces,
  quotes or a leading digit (`First_Name`, with the real name in the note) and
  quote such relation labels.
- **Changed:** `init` in a project that already has `src/database/schema.ts`
  imports that module's schema: its `appSchema` export, or the one `schema(…)`
  value it exports, by name or as its default (also
  `const db = schema(…); export default db`). The module is read, not run, and
  only plain top-level forms count. When it offers none or several, or something
  init cannot read with certainty (`export *`, a re-export, a schema inside an
  object or a wrapper, several declarators in one statement), init creates
  nothing and exits with 1, saying what to add. Before, it wrote files that
  imported a missing `appSchema`.
- An invalid timeout from the config names the config key
  (`lockTimeoutMs in the config`), not the `--lock-timeout` flag. An empty
  `--lock-timeout` is refused instead of read as 0.
- An invalid database URL (one that is not an absolute URL, which node-postgres
  would read as the host "base") is reported as such, naming `--database-url`,
  `databaseUrl` in the config, `DATABASE_URL`, `--verify-url` or
  `verificationDatabaseUrl`; every URL node-postgres reads, the
  `user:password@/db?host=/socket` form included, still connects.
- `--profile-url` keeps a path prefix (`http://host/prefix/`) and still accepts
  the endpoint itself (`…/requests`).
- **Changed:** a flag that takes a value refuses an empty one. Before,
  `migrate --to ""` applied every pending migration and `--steps ""` rolled back
  one step.
- **Changed:** the profiler endpoint serves bytea parameters as `\x…` hex, not
  as an object of byte indexes.
- `inspect` prints bigint defaults as digits.
- An action's exit code in the dashboard no longer becomes the dashboard's exit
  code.
- `pull` writes database names that contain a line break (`\n`, `\r`, U+2028,
  U+2029), another control character or a text-direction override as escapes in
  its `// pull:` comments, strings and `sql` templates. Before, such a name
  ended the comment, and the rest of it ran as code when the generated module
  was imported. A carriage return in a pulled default or CHECK now comes back as
  itself; before, it came back as a line feed.
- Generated migrations write names, enum labels and embedding model names in
  their `-- symmetria: caution:`, `-- symmetria: destructive:` and backfill
  comments the same way. Before, a line break in an index name or enum label
  turned the rest of the comment into SQL that ran with the migration; a crafted
  name could drop tables. The review printed by `generate` and `lint` keeps each
  finding on its own line.
- In migration SQL, a carriage return ends a `--` comment, as it does in
  PostgreSQL. The statement after it is now split and linted; before, lint
  skipped it while PostgreSQL ran it.
- **Changed:** a negative number in a schema expression (CHECK, index WHERE,
  expression index key) is written in parentheses, `"n" > (-5)`. Written right
  after a minus sign, `-5` started a SQL comment (`"n"--5`): CREATE TABLE
  failed, or the check silently lost the rest of its line. `${-5}::text` failed,
  because PostgreSQL read it as `-(5::text)` and cannot negate text. Snapshots
  saved with the old spelling need no migration, and drift and pull treat both
  spellings as the same. This includes a number cast through text,
  `(-0.5)::text::real`, which Symmetria writes when it compares a `real` column
  or array element with a negative number, and in arithmetic on array elements
  and `match()` values; 3.5.0 wrote `-0.5::text::real`. It also includes a
  negative number before a cast that changes it, `${-0.5}::integer` or
  `${-0.25}::real::float8`: PostgreSQL reads 3.5.0's `-0.5::integer` as
  `-(0.5::integer)`, which is -1 like `(-0.5)::integer`. Only SQL whose old
  spelling PostgreSQL refused or read as another value is written again in the
  next migration: `-5::text`, a number that reaches an integer type's most
  negative value on the way (`-32767.5::smallint` fails, `(-32767.5)::smallint`
  is -32768), and a float that comes out zero (`-0.4::integer::float8` is -0,
  `(-0.4)::integer::float8` is 0).
- `generate`, `drift` and `pull` no longer take a float's negative zero for
  zero. `(-0::float8)::text` is `-0`, while `((-0)::float8)::text` and
  `'0'::float8::text` are `0`. A check changed from one to the other now gets a
  migration, and `pull` keeps the negative zero: `CHECK (f <> -0::float8)` is
  pulled as an `sql` condition where 3.5.0 wrote `f.isNot(0)`.
- `generate`, `drift` and `pull` keep each cast of a chain over a literal that
  gives it another value: a number out of an inner integer type's range or a
  numeric(p,s)'s digits (`-32768::smallint::integer` fails,
  `(-32768)::smallint::integer` is -32768), a number with an exponent cast to an
  integer (`2.5e0::integer` is 3), and a float cast on to an integer, which
  rounds half to even (`2.5::float8::integer` is 2, `2.5::integer` is 3), or on
  to double precision (`0.1::real::float8`). Before, a check changed from one
  form to the other got no migration. Schemas saved before need no migration.
- **Changed:** bytea defaults and literals in DDL are written as escape strings,
  `E'\\x4142'::bytea`. Index storage options and pull's suggested fixes that
  contain a backslash are written the same way. With
  `standard_conforming_strings = off`, the old `'\x4142'` stored the bytes
  `413432`. Saved snapshots need no migration.
- **Changed:** in a `transaction: "none"` (`--online`) migration,
  `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`,
  `REINDEX … CONCURRENTLY` and `VALIDATE CONSTRAINT` wait without the default
  five-second lock timeout. Their waits block no reads or writes.
  `DETACH PARTITION … CONCURRENTLY` keeps the default: its last step takes an
  ACCESS EXCLUSIVE lock on the partition, which every query of the partition
  would wait behind. Before, any query in the database that ran longer made the
  migration fail with SQLSTATE 55P03, leaving an invalid index and a migration
  to repair. Other statements keep the default; a `lockTimeoutMs` or
  `--lock-timeout` you set applies to every statement.
- When the migration's connection is lost during a statement (server process
  terminated, failover), `migrate` and `rollback` report the
  `MigrationExecutionError` naming the migration, statement, SQL and SQLSTATE,
  also with `--json`, instead of "Connection terminated unexpectedly". Cleanup
  that fails afterwards adds a line to the message, and a `none` migration's
  error is written to the journal over a fresh connection, tried again for up to
  ten seconds while the pool still hands out connections lost with the session.
  A new connection that the server refuses (the server is down), or Ctrl-C, ends
  the wait at once, and the error says the journal does not record it. When the
  wait ends, an attempt still waiting for its connection writes nothing once it
  gets one, so the journal never shows an error the message says it lacks; if
  its COMMIT was already under way, the message says the journal may not record
  it. Ctrl-C cancels the migration's statement only while one runs, not after
  its session was lost. A failed or interrupted CLI command waits at most half a
  second for its connections to close, then prints its error and exits. In your
  own code, `driver.close()` still waits for such an attempt until its
  connection opens or fails: Bun.SQL gives up after its `connectionTimeout` (30
  s by default); with node-postgres set `connectionTimeoutMillis`, or it waits
  forever.
- A database whose new connections take more than a second to open is no longer
  taken for a transaction pooler. The check waits up to ten seconds for its
  second connection, so `--online` migrations run and batch migrations keep the
  session lock. When the check cannot tell (no free connection, or none opened
  in ten seconds), the refusal of a `none` migration says which.
- **Changed:** `status` reports an incomplete `none` migration that another
  process still runs (it holds the migration lock) as running in another
  process, with `running: true`, and exits with code 0. "repair required" and
  exit code 1 are kept for one that stopped. A `migrate` that gives up waiting
  for the migration lock names the PostgreSQL process holding it, and the
  refusal of an incomplete migration says no other process is running it.
- `drift` on a database whose last migration is incomplete names it, the error
  it stopped with and the `repair` it needs (or that another process runs it),
  instead of "1 migration behind … Run migrate". `--json` carries `incomplete`;
  `--strict` exits with code 1 unless it is running.
- **Changed:** `generate --online` and `lint --online` describe the SQL they
  write. A concurrent index build runs outside a transaction and blocks no
  writes. A NOT NULL set through a validated CHECK is a caution like an online
  CHECK; `lint --online` used to exit 1 for every such change. `lint` of the
  saved file no longer calls the temporary `DROP CONSTRAINT …_not_null_…` a
  rebuild, passes `SET NOT NULL` behind a valid `CHECK (column IS NOT NULL)`,
  and describes `NOT VALID`, `VALIDATE CONSTRAINT` and `UNIQUE USING INDEX`
  instead of giving a generic caution.
- When no verification server is configured, `repair --action retry` of the
  latest migration checks its starting point against the snapshot from before it
  that `meta/migration.json` keeps (`undo`), so it needs neither `--verify-url`
  nor `--snapshot`.
- **Changed:** SQL lint lets a `DROP INDEX` or `DROP CONSTRAINT` pass as
  harmless only when an earlier statement surely created that object: not after
  `CREATE INDEX … IF NOT EXISTS`, not when the CREATE names another schema, not
  when the name was dropped before it was created, and not when a statement
  between them changes `search_path` or the role (`SET search_path`,
  `SET SCHEMA`, `RESET`, `set_config('search_path', …)`, `SET ROLE`,
  `DISCARD ALL`, `set_config('role', …)`, `ALTER SCHEMA`, `DROP SCHEMA`, or a
  `DO` block, `CALL` or `EXECUTE`, whose code lint cannot read; a `set_config()`
  in a view's query or a function body, and these words in a name, a comment or
  a string, do not count). The drop follows its object's renames in its own
  schema: a rename of that name in another schema leaves it as it was, and one
  that may or may not be of it (the name written with its schema on one side and
  without on the other) means it may be another object, so the drop is not
  harmless. It is destructive when another object was renamed into its name in
  that schema in between, or when its table moved to another schema
  (`ALTER TABLE … SET SCHEMA` takes the table's indexes along). A drop rates as
  a rebuild (caution) only when the object is created again after it, on the
  same table (also after the table's `RENAME TO` in its schema, not after it
  moves to another schema) and in the same schema; otherwise it is destructive.
  3.5.0 called it a rebuild whenever that name was created anywhere in the file,
  even on another table.
- **Changed:** a valid `CHECK (column IS NOT NULL)`, which lets a later
  `SET NOT NULL` pass lint as harmless, follows its column through
  `RENAME COLUMN`, itself through `RENAME CONSTRAINT` and its table through
  `RENAME TO`, and goes away with `DROP COLUMN`. It proves nothing for a table
  name another table was renamed into, nor after that name's `DROP TABLE`,
  `SET SCHEMA` or `CREATE TABLE`/`SELECT … INTO`, nor after a `DO`, `CALL` or
  `EXECUTE` in between, nor, for a table named without its schema, once
  `search_path` changes in between. Before, a table swap
  (`ALTER TABLE t RENAME TO t_old; ALTER TABLE t_new RENAME TO t`) let
  `SET NOT NULL` on the new `t` pass as harmless, and PostgreSQL then failed on
  its NULLs. A table created in the migration, once renamed or dropped, no
  longer makes statements on its old name look harmless.
- `lint` no longer takes a `-- symmetria: caution:` or
  `-- symmetria: destructive:` line inside a quoted name or string as a note, so
  a statement cannot lower its own rating through a name.
- Names with line breaks (U+2028 and U+2029 included) print as escapes in
  `graph` Mermaid output, in `diff`, and in the `-- group …` line of
  `migrate --plan` / `rollback --plan`.
- `lint --pending` while a migration runs in another process says so, instead of
  asking to repair it.

## 3.5.0 — 2026-11-22

Fixes from a bug hunt on 3.4.1: whole-table writes and lost data that slipped
past the 3.4.0 checks, regressions brought in by the 3.4.0 and 3.4.1 fixes, and
places the last hunt did not reach (migrations, transactions, better-auth).

### Runtime (`symmetria`)

- **Changed:** `UPDATE` and `DELETE` also refuse a filter that holds for every
  row whatever the data ("where() leaves no condition"): `notIn()` or
  `not(in())` of a query that finds nothing (an emptied `in([])`, `limit: 0`),
  an aggregate of an emptied relation compared so that it holds for every row
  (`user.posts({ where: (post) => post.id.in([]) }).count().is(0)`,
  `.exists().is(false)`), `exists()` of an aggregate without `groupBy`, a count
  compared with what every count passes (`count().atLeast(0)`, `isNot(-1)`), and
  `isNot(null)` of a NOT NULL column. Before, such a write reached every row of
  the table.
- Several `where()` calls on one write make one filter:
  `.where((u) => u.id.is(1)).where(() => [])` writes the one row instead of
  being refused, and `.all()`, before or after, accepts a filter that holds for
  every row as the whole-table write it asks for. `notExists()` of an aggregate
  query (one row even over no rows) is no longer refused.
- 3.4.0 regression: a prepared `.nullable` parameter on an enum column bound to
  `null` made `not(is(p))` and `not(isNot(p))` find nothing, and a prepared
  delete with them delete nothing. They now match like `not(is(null))`.
- **Changed:** on a JSON path and a nullable `jsonb` column, `not(is(x))`,
  `not(in([…]))`, `not(between(…))` and `not(contains(…))` in a query leave out
  a stored JSON `null`, as `isNot(x)` and `notIn([…])` do; also in writes. CHECK
  constraints and partial indexes declared with such a `not()` keep their SQL,
  so upgrading needs no migration, and a query with the same `not()` still uses
  such a partial index.
- 3.4.1 regression: `page()` cursors issued by 3.4.0 for queries ordered by,
  filtered by or selecting a vector distance were refused. They work again;
  cursors issued by 3.4.1 itself for those queries are refused once.
- `in()` / `notIn()` lists longer than 1,000 values bind one array parameter for
  every column type, as documented: enum, timestamp, double precision, real,
  interval, inet, time, bytea, JSON paths and the rest. Above 65,535 values they
  failed (pg: a misleading `ConnectionError`; Bun: a raw driver error). A
  statement that still binds more than 65,535 values (a list of expressions) is
  refused with a `QueryError` before it is sent.
- An upsert whose value is a subquery returning more than one row reports
  PostgreSQL's error ("more than one row returned by a subquery") instead of
  `DuplicateConflictKeyError`.
- `box` arrays (`customType("box", …).array`) are read correctly on symmetria/pg
  and can be written on both drivers (PostgreSQL separates their elements with
  `;`).
- **Changed:** `get()`, `find()`, `one()`, `maybeOne()`, `first()`, `count()`,
  `exists()`, `aggregate()`, `page()` and `$batch()` start when they are
  awaited, as queries and writes do, instead of when they are called; they are
  still real promises and still run in the async context where they were made
  (`$scope()` callbacks, profiler requests and tracer spans see that context).
  In a transaction, `Promise.all([tx.logs.insert(row), tx.logs.count()])`
  counted before the insert and `Promise.all([byId(1).update(…), get(1)])`
  returned the old row, against the documented order; an array now runs in its
  order. Inside a `$batch()` callback such reads still join the batch when they
  are made. A read that is never awaited no longer runs. A read made through a
  transaction before one of its savepoints and first awaited inside that
  savepoint's callback is refused ("await the nested transaction before using
  its parent context"); before, it had already run. With a pool of one
  connection, a read made outside a transaction and first awaited inside it is
  refused ("…holds the only one"), as a query is. `execute()`, `inspect()` and
  prepared queries still start when called.
- A stream of a transaction that was read on inside one of its savepoints hung
  the transaction and `$close()` for good. Its fetch is now refused there like
  any query through the parent ("await the nested transaction before using its
  parent context"); a `break` there ends the loop, and its cursor is closed when
  the savepoint ends.
- A stream left open when its transaction or savepoint rolled back kept handing
  out the rows it had fetched, data that was rolled back. Reading on now fails
  ("the transaction of this stream ended while the stream was open and was
  rolled back"); a `break` there just ends the loop.
- `stream()` inside `$transaction` no longer leaves `cursor_tuple_fraction = 1`
  set for the rest of the transaction. A session's `execute()` and `cancel()`
  and a transaction driver's `execute()`, called after their callback ended,
  reject instead of throwing.
- `aggregate()` on a source with `limit` or `offset` failed on relation paths
  and relation aggregates, with an error naming an internal table; with
  `orderBy` alone, or on a grouped source with a limit, it failed with
  PostgreSQL's GROUP BY error, and on a DISTINCT source with a limit it counted
  other rows (3.4.0 fix incomplete). It now aggregates the rows the source
  selects, keeping the table's relations: an ordering alone changes nothing, a
  grouped source keeps its groups (several reject with `TooManyRowsError`), and
  DISTINCT whole rows and `forUpdate` sources work too.
- **Changed:** `aggregate()` on a query with `distinct` and selected fields is
  refused; `count()` counts its rows, and `query.as(name).aggregate(…)`
  aggregates its fields.
- A `$batch()` whose reads each define a CTE of one name (a helper called once
  per read) is one statement again, so its reads see one snapshot: an identical
  CTE is defined once, a different one gets its own name in the statement. Since
  3.4.0 such a batch was split into several statements, and a list and its total
  could disagree. CTEs count as identical only when their SQL and every bound
  value match exactly (NaN, Infinity and -0 included). A different one gets a
  new name in the statement, at most 63 bytes, that no table of the schema, no
  name the reads use and nothing in their raw SQL already has; when no such name
  can be formed, the batch is sent as separate statements, as before.
- Docs: what a `$batch` split by its size keeps of the snapshot, and why a query
  a `stream()` loop starts is refused when the loop holds every connection,
  whether or not the loop awaits it.
- A slot, column or required column named like an `Object` member
  (`constructor`, `toString`, `valueOf`, `hasOwnProperty`) is that slot or
  column: `one(owners.valueOf)` no longer reads it as a column, and an insert
  that leaves out a required `constructor` column is refused as "missing
  required column".
- `symmetria/better-auth`: field names given to better-auth
  (`user: { fields: { name: "full_name" } }`) work. `npx auth generate` keeps
  better-auth's field names as keys with those SQL names (`.named()`, and
  `.column()` for references), and the adapter translates rows and filters.
  Before, every write failed with "unknown column". Columns of the application's
  own on an auth table go back beside better-auth's fields, and a field wins
  where its stored name meets such a column's key.
- `symmetria/better-auth`: with `usePlural: true`, `npx auth generate` writes
  plural table keys (`users`, `sessions`), as the adapter asks for them; `in` /
  `not_in` with `mode: "insensitive"` compare without case;
  `generateId: "serial"` is refused when better-auth starts instead of failing
  at the first sign-up with "missing required column".

### Kit (`symmetria-kit`)

- A table or column whose SQL name is an `Object.prototype` member
  (`constructor`, `toString`, `valueOf`, `__proto__`, …) is no longer dropped
  and added again, with its data, by every later migration. `diff`, `generate`,
  `lint` and the rename prompt read rename hints and `using` keyed by such
  names.
- **Changed:** a type change whose plain cast reads the time zone of the session
  running the migration converts at UTC, in `up.sql` and `down.sql`: `date` →
  `timestamptz` and `timestamptz` → `date` / `time` use `AT TIME ZONE 'UTC'`; a
  value → `timetz`, text ↔ `timestamptz` / `timetz` and arrays run with the zone
  set to UTC around the statement. Before, under `America/New_York`,
  `2024-01-02` became 05:00 UTC and `2024-01-02 03:04:05+00` became the date
  `2024-01-01`.
- **Changed:** `generate` refuses a type change between built-in types that
  PostgreSQL has no cast for, in either direction, unless `using` gives both
  conversions: `integer` → `date`, `boolean` → `numeric`, `date` → `integer`,
  `bigint` → `boolean`, and `jsonb` → `integer`, whose `down.sql` needs
  `integer` → `jsonb`. `integer` ↔ `bytea` counts as castless, as before
  PostgreSQL 18.
- **Changed:** `numeric` to an integer type, or to a `numeric` with fewer digits
  before the decimal point, is narrowing and needs `--allow-destructive` when
  values can exceed the target (`numeric(20,0)` → `integer`, `numeric(10,2)` →
  `numeric(8,2)`).
- **Changed:** `generate`'s review and `lint` of the saved file fail on the same
  changes. Adding an identity column is a rewrite caution; dropping an index,
  constraint or enum type that is no longer declared is a caution, written in
  the SQL as `-- symmetria: caution: …`; a composite key reordered or widened
  and a foreign key rebuilt only for its actions are cautions; a new unique
  column with a constant default and a primary key moved to other columns are
  blocking in `generate` too; removed enum labels carry a destructive note; a
  primary key over a newly added identity, sequence or uuid-generator column is
  a caution in both; a `-- symmetria: caution:` note counts only on the
  statements generate writes it on. Hand-written SQL is rated as before.
- **Changed:** SQL lint: `ADD COLUMN` with `REFERENCES`, `CHECK`, `UNIQUE` or
  `PRIMARY KEY` is blocking when existing rows get a value, and a `PRIMARY KEY`
  column without one is blocking; a key on a column added in the same migration
  is a caution when its rows hold only NULLs, or each got their own value from
  an identity, a sequence or a uuid generator (`gen_random_uuid()`, `uuidv7()`;
  not `clock_timestamp()` or `random()`, whose values can repeat), unless a
  statement in between (an `UPDATE` backfill, a `USING`, a `DO` block) may have
  written it; a `USING` cast to `varchar(n)` is destructive however the type is
  spelled, and so is a `USING` whose whole expression is `NULL` or another
  constant.
- **Changed:** `pull` reads a full-text search back as
  `.search(…{ words: fullText(…) })`, so a declared schema pulled back needs no
  migration, has no drift and `adopt` takes it. `pullSchema()` takes
  `searchModule`. Only a nullable column that no other index or constraint uses
  is taken as a search; any other stays a column with its warning.
- A CHECK or index-condition literal that PostgreSQL stores in another spelling
  is no change: `time '23:00'`, `interval '24 hours'` (`24:00:00`), an
  upper-case or braced `uuid`, `inet '10.0.0.1/32'`, also as a typed literal or
  in an `in()` list (`t.iv.in(["1440 minutes"])` and `'24:00:00'`). Intervals
  compare as PostgreSQL keeps them, months, days and time apart, so `'1 day'` →
  `'24 hours'` is still a change; `pull` writes the literals as stored.
- A `using` conversion missing `up` or `down` is refused with a message that
  names the missing direction (it crashed).
- `testDatabase()` checks its options before creating anything and cleans up
  after any failure. Before, a refused `searchPath` left the schema behind and,
  with node-postgres, a pool that kept the process alive.
- `drift` accepts `DEFAULT CURRENT_TIMESTAMP` for `.now`; `pull` warns about
  `UNLOGGED` tables (`unlogged`) and identity sequences with options
  (`sequence`).

## 3.4.1 — 2026-11-22

### Runtime (`symmetria`)

- A vector compared by distance (`table.search()` by meaning, `orderBy` and
  `where` on a distance) is bound as `(SELECT $1::text::vector)` and read once
  per statement. Bound as `$1::text::vector`, it was read again for every row
  compared once PostgreSQL planned the statement for all values, which it may do
  from the sixth run of a statement the connection keeps prepared (Bun's
  default, or `symmetria/pg` with `prepare: true`): a filtered search by meaning
  with vectors of 1024 numbers went from 14 ms to 370 ms and stayed there. A
  vector used several times in one statement is also sent once. Such a plan for
  all values still sorts every row a `where` leaves instead of following the
  vector index, about 3 µs a row; `postgres({ url, prepare: false })` avoids it.

## 3.4.0 — 2026-11-22

Fixes from a bug hunt on 3.3.0: wrong results, lost or wrong stored data,
crashes and hangs.

### Runtime (`symmetria`)

- **Changed:** `UPDATE` and `DELETE` refuse a relation quantifier that holds for
  every row, as they refuse an empty filter ("where() leaves no condition"):
  `every()` over a list whose entries were all skipped, `none()` or
  `not(some())` over an empty `in([])`, `notExists()` of a query that finds
  nothing. Before, such a write reached every row of the table.
- **Changed:** a prepared lookup by key (`by.<key>(p.x)`, `byId(p.id)`, `get`,
  `find`) refuses a parameter declared `.nullable`: bound to `null` it would
  compare as `IS NULL` and reach every row whose key is NULL.
- **Changed:** on a nullable `jsonb` column, `is(null)` and `isNot(null)` count
  a stored JSON `null` as null, as reading it back and a JSON path do; a
  prepared `path.is(p)` bound to `null` does the same.
- **Changed:** in option callbacks (`where`, `orderBy`, …), `join`, `innerJoin`
  and `leftJoin` of a relation without `.as()` return the JOIN of that relation
  and kind the projection made, as documented. Before, each call joined the
  relation again and rows multiplied (3 posts became 18 rows). With two such
  JOINs in the query, a call without a name is refused. In the projection each
  call is still a JOIN of its own.
- **Changed:** a path through a relation after `crossJoin()` of that relation
  (`post.editor.name` after `crossJoin(post.editor)`) reads the row's own
  related row; it read the cross-joined row, which gave wrong values and
  filters. The cross-joined row is the value `crossJoin()` returns, a selected
  field, or a path that names the JOIN's alias
  (`crossJoin(post.editor.as("any"))`, then `post.editor.as("any").name`).
- **Changed:** an upsert row that leaves out one of the embedded columns is
  written without an embedding (`NULL`, for `reindex()`); so is a row with a SQL
  expression in one of them. Before, the embedding was made of the columns the
  row carried and described text the stored row did not have.
- **Changed:** a `traced()` span of a failed statement names the error by class,
  SQLSTATE and constraint (`QueryError (23505) on constraint "…"`) instead of
  recording PostgreSQL's message and stack, which can quote a value.
- **Changed:** on a JSON path and a nullable `jsonb` column, `isNot()`,
  `notIn()`, `above()`, `below()` and `isDistinctFrom(null)` treat a stored JSON
  `null` as null, as `is(null)` does: `isNot(3)` no longer returns rows whose
  value is JSON null.
- **Changed:** an `update()` or `delete()` whose filter leaves no condition (a
  list emptied by request values, `where: { authorId: undefined }`) is refused
  when it runs or compiles, like a missing `where()`, so the write's `catch()`
  sees it; it threw while the write was built.
- **Changed:** a session PostgreSQL ends because a transaction was idle or open
  too long (SQLSTATE 25P03, 25P04) is a `ConnectionError` of kind `connection`
  on both drivers; it was a plain `QueryError` on Bun. On `symmetria/pg` a lost
  connection reports the server's reason (`57P01`) instead of the generic
  `08006`.
- Upsert keys PostgreSQL holds equal in another spelling (`10.0.0.1` and
  `10.0.0.1/32`, `1 day` and `24:00:00`) are refused with
  `DuplicateConflictKeyError` instead of PostgreSQL's "cannot affect row a
  second time"; an upsert split into several statements checks its keys with
  PostgreSQL first, where the later row used to overwrite the earlier one.
  Timestamp keys before 2000 are rounded as PostgreSQL rounds them.
- A prepared `.nullable` parameter on an enum column compares like the literal
  (`isNot(p.state)` left out NULL rows only for the literal).
- `aggregate()` of a source with `limit` or `offset` aggregates the rows they
  leave; before, they applied to the one result row.
- `count()` and `exists()` of a query whose projection aggregates every row (no
  `groupBy`) count its one row.
- `$batch` runs reads that cannot share one statement (two CTEs of one name)
  separately instead of failing all of them.
- A relation's aggregate or quantifier inside the first shape of the same
  relation (`user.posts((post) => ({ total: user.posts.count() }))`) works again
  (it failed since 3.1.0).
- DISTINCT ordered by a `bigint` or `numeric` column works inside `$batch`, a
  nested query and a relation collection.
- A path to an enum field of a nested object in a CTE or derived table reads as
  text instead of failing ("type enum does not exist").
- Arrays the driver leaves as PostgreSQL's text (`{happy,sad}`: enum arrays on
  both drivers, range and `tsvector` arrays on node-postgres) read as arrays,
  also from `RETURNING`.
- `minimum()` and `maximum()` of a `halfvec` work, as for `vector`.
- `join()` of a many-to-many relation under a scope on its target no longer adds
  an all-NULL row for each hidden target row.
- Rows created by a nested insert get their embeddings; the model is asked once
  per `INSERT` the nested write sends.
- An embedded table's `upsert(row, { by, update: [...] })` and
  `onConflict().doUpdate(...)` store the embedding they paid for; a bulk upsert
  with one empty-text row is no longer refused as "rows carry different
  columns".
- A nearest-neighbour read with a filter no longer returns too few rows (or
  none) when the matching rows lie far away: pgvector's iterative scan stopped
  at `work_mem × hnsw.scan_mem_multiplier`, which is now raised for the
  statement. The same applied to `table.search()` by meaning above its exact
  threshold.
- An IVFFlat nearest read with `forUpdate` reads on past its lists and is sorted
  again, like one without a lock.
- Full-text search finds words with combining marks (Hindi, Thai, decomposed
  accents) and e-mail addresses.
- A query inside a `for await` loop over `stream()` that would wait for the
  connection the loop holds is refused at once ("from inside a stream() loop
  that holds the only one"), as inside a transaction. A `stream()` iterator read
  partly and dropped without `return()` gives its connection back (the
  transaction rolls back) once it is garbage-collected; before, the connection
  stayed idle in a transaction for good.
- Inside `$transaction`, a stream that fails to decode a row closes its cursor,
  so a callback that catches the error can still commit.
- The pool guard against waiting forever drops transactions that have ended:
  work a transaction scheduled may use the pool while its `COMMIT` runs, a job
  loop no longer slows down round after round, and `$close()` from such work is
  no longer refused as "called inside a $transaction()".
- `postgres({ prepare: true })` from `symmetria/pg`: after a migration changes
  the type of a column a prepared statement reads, the statement is prepared
  again under a new name; outside a transaction the call succeeds, inside one
  that transaction fails once. Before, every later call failed on every
  connection that had prepared it.

- `like`, `ilike`, full-text search and `searchHeadline()` on an enum, uuid,
  date, time, interval or inet column read the value as text, and a text column
  compared with one of them (`is`, `in` a subquery, `coalesce`) compares as
  text; PostgreSQL refused all of these.
- A vector distance reads as a number inside nested results and `$batch`, also
  when it is NaN (it was the string `"NaN"`).
- Nested objects keep their selected key order when PostgreSQL builds them as
  `jsonb` (`distinct`, `groupBy`, derived tables, more than 50 fields).
- `exists()` in the projection of a paginated query keeps the "page the root
  rows first" rewrite, so the subqueries run for the page's rows only, not for
  every row of the table.
- `page()` ordered by a `numeric[]`, `date[]`, `timestamp[]` or `timestamptz[]`
  column accepts its own cursor.
- A prepared parameter declared `jsonb<T | null>()` binds JSON `null`.
- An embedding model answering NaN or Infinity: a hybrid search falls back to
  words, and `insert()` and `reindex()` reject with an error naming the model,
  instead of PostgreSQL's.
- On Bun.SQL a `date` after 275760-09-13 fails to read with an error saying so;
  it read as `"0NaN-NaN-NaN BC"`. An integer parameter of `-0` is sent as `0`,
  so integer arithmetic stays integer on Bun.
- `traced()`: a span is named after the statement's own table, not the first
  table in its text (a nested read, a junction, `extract(… from …)`); a cursor's
  `FETCH` and `CLOSE` carry the stream's table, and a stream's statements are
  children of its transaction span; statements a failed transaction never sent
  are marked `error.type: not_sent` instead of repeating the first error; long
  statement texts are no longer kept in memory.
- `searchHeadline()` options are bound as a parameter instead of written into
  the SQL text.
- `profiler.trace(label, () => query)` records a query the callback returns
  without awaiting.
- Types: `jsonb(schema).array` reads, writes and filters with the schema's input
  type, as `jsonb(schema)` does; an insert accepts `about: undefined` for an
  embedding under `exactOptionalPropertyTypes`; `coalesce()`, `lag()` and
  `lead()` take a plain `number[]` fallback for a vector.
- The better-auth schema generator writes `jsonb()` for a JSON field; the
  generated module did not load.

### Kit (`symmetria-kit`)

- An SQL default longer than one value is written in parentheses:
  `DEFAULT 'a' COLLATE "C"` collated the column itself, and `DEFAULT NOT false`
  or `now() AT TIME ZONE 'UTC'` did not parse.
- A migration deleted by removing only its directory: `discard` takes it out of
  the journal and puts the snapshot back, and the error every other command
  gives says so. Before, `discard` refused with the same error.
- `vector(n)` to `halfvec(n)` is a caution that says what half precision does:
  numbers are rounded to about 3 significant digits, and one beyond ±65504 makes
  the migration fail.
- `pull` writes `money` as `string` (it arrives formatted, `$12.50`), reads an
  `oid` or float column without a builder as a number also inside nested
  results, and writes an array of a type without a builder (an enum array) as an
  array of its element type, which reads as an array. Re-run `pull` for a schema
  it wrote before as `customType<string[]>("mood[]")`, which reads as text.
- `numeric(p)` and PostgreSQL's `numeric(p,0)` are one type for drift, `adopt`
  and generated migrations.
- An index declared with its type's default operator class (`text_ops`,
  `array_ops`, `vector_l2_ops`) no longer reports drift after `migrate`.
- Extension names may contain a hyphen, as `uuid-ossp` does; a schema `pull`
  wrote for such a database did not load.
- `pull` of a database made with `casing: "preserve"` whose table and column
  names are single lowercase words reads an index named with a capital
  (`items_byName_idx`) as such; it chose the default casing, skipped the index
  and the next migration dropped it.
- A generated migration no longer rebuilds an index that differs only in
  PostgreSQL's default ordering (`.ascending`, `.descending.nullsFirst`) or in
  how a storage value is written (`fillfactor: "50"` and `50`).
- An expression index key in parentheses, `(name COLLATE "C")`, has no drift
  after `migrate`, and `adopt` takes it.
- A CHECK or partial-index condition comparing a column with a quoted literal
  (`num.above("0")`, which PostgreSQL stores as `num > '0'::numeric`) is no
  change after `pull`; it was dropped and added again.
- Defaults that differ only in how PostgreSQL prints the value (arrays, JSON,
  timestamps, intervals such as `90 minutes` and `01:30:00`) are no change, so
  the first migration from a pulled schema does not set them again.
- A narrowing type change and cleared embeddings are written with a
  `-- symmetria: destructive: …` comment above them, and `lint` of the saved
  file rates them as destructive, as `generate` did; it rated them as caution.

## 3.3.0 — 2026-11-21

Fixes and additions from running Symmetria in production with a search by
meaning over about 150,000 messages.

### Runtime (`symmetria`)

- `search.reindex()` no longer reads rows that have nothing to embed: a row
  whose embedded columns are all empty or NULL is left out by the query itself.
  Before, every call read such rows again; 15,000 of them cost about 235 empty
  round trips per pass at a batch of 64.
- `search.reindex()` writes a batch with one `UPDATE` instead of one per row,
  and no longer stores an embedding of text that changed while the model was
  answering (the row is embedded by the next call) or overwrites an embedding
  written in the meantime.
- `search.reindex({ order: "desc" })` starts from the highest primary key, so
  with increasing keys the newest rows are embedded first.
- New `search.missing({ where })`: how many embeddings `reindex()` would compute
  now.
- Half precision for embeddings: `meaning: model(...columns).half` keeps the
  embedding as `halfvec` (pgvector 0.7+) with a `halfvec_cosine_ops` index, in
  about half the space; models of up to 4,000 dimensions can then be indexed.
  `halfvec(n)` from `symmetria/vector` declares such a column directly.
- `find()`, `get()`, `byId()`, `by.<key>()` and a nested `connect` accept a safe
  integer for a `bigint` key in their types, as writes and filters already did;
  the runtime already accepted it.
- `onConflict()` and `upsert({ by })` take the name of a unique index as
  `by.<name>` names it (`onConflict("identity")` for
  `identity: index(…).unique`).
- Queries, writes and searches are assignable to `Promise<…>` in TypeScript:
  their `then`, `catch` and `finally` are typed as a promise's, and they carry a
  `Symbol.toStringTag` (`SymmetriaQuery`, `SymmetriaWrite`). A function typed
  `(): Promise<Row[]>` can return a query without `.execute()`.

### Kit (`symmetria-kit`)

- **Changed:** a search's snapshot records the model and the columns its
  embeddings are made of. Another model of the same length, or other columns,
  makes the migration clear the stored embeddings (`UPDATE … SET about = NULL`),
  which `lint` reports as destructive, so `generate` needs `--allow-destructive`
  and `reindex()` computes them again. Before, such a change produced no
  migration and the old embeddings kept describing the old text. Snapshots from
  earlier releases lack the record, so the first such change after upgrading is
  not noticed.
- Turning a search's meaning to `.half` and back converts the stored embeddings
  in place and builds the index again with the matching operator class; `pull`
  reads `halfvec` columns back.
- New command `discard [id]`: takes back the latest migration while no database
  has applied it, restoring the snapshot and the journal, so it can be generated
  again. It asks the configured database first (`--force` without one, or for an
  edited `up.sql`). The journal now keeps the snapshot before the latest
  migration (`undo`), which older releases ignore; for migrations generated
  before, the earlier snapshot is taken from the Git history. A migration
  deleted by hand, which made `generate`, `status` and `diff` refuse with
  "snapshot checksum does not match the migration journal", is repaired by
  `discard` too, and that error now says so.
- `generate` prints the review `lint` gives the new migration, so a caution such
  as a rewritten table is seen without running `lint`. The caution for a changed
  `fullText()` says that every index of the table is built again and names the
  vector index among them.
- `testDatabase()` creates the extensions a schema needs (`vector`, `pg_search`)
  when they are missing and puts their schemas on the test schema's
  `search_path`; a manual `CREATE EXTENSION` and the `searchPath` option are no
  longer needed for them.

## 3.2.0 — 2026-11-20

### Runtime (`symmetria`)

- New entry `symmetria/opentelemetry`: `traced(driver, { tracer })` reports
  every statement as a client span (`SELECT users`, with `db.system.name`,
  `db.operation.name`, `db.collection.name`, `db.query.text`, returned rows and
  the SQLSTATE of a failure) and every transaction as a span around its
  statements. The tracer is passed in, so the package gains no dependency.
  Values are never recorded. It also wraps a driver that carries a profiler.
- ``sql<boolean>`…` `` is accepted wherever a predicate is: `where`, `having`,
  predicate lists, `and()` / `or()` / `not()`, JOIN conditions, mutation
  `where()` and scopes, and it has `.and()` / `.or()`. Before, it had to be
  written ``sql<boolean>`…`.is(true)``.
- **Changed:** `is(null)` and `isNot(null)` on a JSON path
  (`doc.meta.path("size").is(null)`) count a key that holds JSON null as null,
  like a missing key. The path already read back as `null` in both cases and
  `coalesce()` / `whereNotNull()` already treated them alike; `is(null)` used to
  match only the missing key.
- A table with an embedding no longer asks the model for rows the write then
  refuses: a missing required column, a value its column cannot hold, an unknown
  column or an impossible chained call rejects the insert or upsert first.
- A scope on a junction table (`$scope({ postsTags: … })`) is now covered by
  tests and described in the reference: reads through the relation see only the
  admitted links, and a nested `connect` is checked like any other insert.

### Benchmarks

- Reads warm up sequentially for one second (`BENCH_WARMUP_MS`) after the
  concurrent burst. With 128 warm-up calls a pass could start before the runtime
  had finished compiling the library's code, and the same scenario then differed
  by a factor of two or three between passes.

## 3.1.0 — 2026-11-17

### Runtime (`symmetria`)

- `symmetria/pg`: `postgres({ url, prepare: true })` sends reads and writes as
  named prepared statements, parsed once per connection. Measured through
  node-postgres on a local database: a point read 123 µs to 105 µs, a list with
  a JOIN 208 µs to 152 µs, a nested read 6% faster. Off unless set; the
  reference says when not to turn it on (an old connection pooler, general
  plans, a column retyped under running connections).
- `byId(key).one()` and `.maybeOne()`, and the same on a unique lookup
  (`by.email(…).one()`), use the statement `get()` and `find()` compile once per
  table and key instead of building and compiling a query on every call: 2.5 µs
  of client work became 0.9 µs, about 4 µs off an 80 µs point read on a local
  database. A shape, options, a scope or a profiler take the ordinary path, as
  with `get()`.
- A path through a to-one relation (`post.author.name`) no longer builds the
  relation's methods (`count()`, `sum`, `some()`, …) it does not use, and `sum`
  / `average` / `minimum` / `maximum` of any relation are built when first read:
  building a list query with one path takes 3.3 µs instead of 4.7 µs.
- A read with nested rows does less work per call. Measured on a page of 50
  users with three posts each and their tags, without a database: building and
  compiling the query 18 µs to 11 µs, decoding the rows 8 µs to 4 µs, the whole
  call 31 µs to 17 µs. Nested rows whose fields need no decoding are returned as
  the driver parsed them instead of being copied; a row decoder is found by its
  field names; the tools a shape callback receives (`join`, `whereNotNull`,
  `row`) and a relation's methods are made when they are read; column handles
  share one set of getters per table; the first shape of a relation reads the
  relation's own sources instead of a copy of them.
- Bulk inserts spend half the client time per row (170 µs to 81 µs for 500 rows
  of three columns): a value node is built without object spreads and a column
  is found by name in a map instead of a search per value.

## 3.0.0 — 2026-11-17

Fixes from a bug hunt over 2.5.0: complex reads, cursor pages, tenant scopes,
transactions, value round trips, search and about ninety schema migrations were
compared with hand-written SQL on PostgreSQL 16 and 18.

### Changed behaviour

- **An UPDATE or DELETE whose filter holds for every row is refused.** A list
  that filtered down to nothing
  (`where: (post) => [userId && post.authorId.is(userId)]` without a user),
  `where: []`, `and()`, `not(or())` and `notIn([])` used to write the whole
  table; they now throw "where() leaves no condition", as `where: {}` already
  did. `.all()` remains the way to write every row. A filter no row passes
  (`in([])`, `or()`) still writes nothing.
- **A `$scope()` no longer stands in for a filter.** `tenant.posts.delete()`
  deleted every post of the tenant; it is refused like an unscoped
  `posts.delete()`, and `tenant.posts.delete().all()` says it.
- **Under `$scope()`, a path to a scoped table keeps the row.** A required
  relation was an INNER JOIN with the scope in its `ON`, so a comment whose
  author the scope hides vanished from any query that read, filtered or ordered
  by `comment.author.name`, and `post.comments.every(…)` did not count it. The
  path is now a LEFT JOIN when its target has a scope: the row stays and the
  field is `null` (its type still says `string`). The smart `join()` follows;
  `innerJoin()` keeps the old result.

### Runtime (`symmetria`)

- 2.5.0 regression: code started inside a `$transaction()` and still running
  after it (a timer, a background loop, a promise nobody awaited) was refused
  with "would wait forever" on every later query through the database, although
  the connection was free again; with `max: 1` one `setTimeout` was enough. Only
  transactions that are still open count now.
- `forUpdate` / `forShare` failed with "FOR UPDATE cannot be applied to the
  nullable side of an outer join" when the query followed an optional relation
  (`post.editor.name`). Without `of`, such a query locks its root table and the
  tables joined with INNER JOIN.
- `symmetria/pg` asks every new connection for PostgreSQL's default output of
  intervals, `bytea` and doubles, as it did for dates: with
  `bytea_output = escape` every `bytea` read threw, `IntervalStyle` changed the
  text of an interval, and `extra_float_digits = 0` read `0.30000000000000004`
  as `0.3`. `bytea` is read in the `escape` form on both adapters.
- `sql` is a template tag only: `sql(["now()"])`, called as a function, ran its
  argument as SQL.
- Refused by name instead of by PostgreSQL or not at all: an array as a key of
  `get()` / `find()` / `byId()`, `limit: "5"`, and an object or array written to
  a `text` or `varchar` column (it was stored as its JSON text).
- `symmetria/better-auth`: `incrementOne` without a filter says `.all()`.

### Kit (`symmetria-kit`)

- Dropping a column that a full-text search read failed with "cannot drop column
  … because other objects depend on it": the generated document column is now
  dropped first.
- Replacing an embedding model by one of another length failed on the first
  stored embedding ("expected 1536 dimensions, not 1024"). The migration empties
  the column (`USING NULL`) and `lint` reports it as destructive; run
  `search.reindex()` afterwards.
- A type change PostgreSQL has no cast for (`integer` to `uuid`, a value to an
  array of it) produced SQL that failed even on an empty table; `generate`
  refuses it and asks for the conversion under `using` in the `--diff` file.

## 2.5.0 — 2026-11-17

Fixes from a bug hunt over 2.4.0: five areas (reads, bulk writes, key lookups
and windows, search, concurrency and migrations) were run against databases of
300 thousand to 10 million rows on both drivers.

### Runtime (`symmetria`)

- **Nearest-neighbour queries no longer lose rows.** pgvector's HNSW index picks
  40 candidates and applies the other filters afterwards, so `orderBy` a
  distance with `limit: 100` returned 40 rows, and with a `where` that the
  neighbours failed it returned none. A query ordered by an ascending distance
  with a `limit` now widens the index scan for its own statement
  (`hnsw.ef_search`, and `hnsw.iterative_scan` from pgvector 0.8). `page()`
  ordered by a distance compares rows exactly. See "pgvector" in the reference.
- **`search()` by meaning with `where` or `$scope()` returned nothing** when the
  nearest rows failed the filter, and a hybrid search silently became a search
  by words. Up to 10,000 rows that pass the filter are now ranked exactly (a
  search within one tenant of 300 thousand documents: 4 ms, with the 10 right
  rows instead of none); more are ranked through the index, which keeps
  scanning. `limit` above 40 returns `limit` rows.
- **`stream()` returns the rows `await` returns.** PostgreSQL planned the cursor
  to start fast and could pick an approximate vector index: a query that
  returned 7,143 rows streamed one. The cursor is now planned to be read to the
  end (`SET LOCAL cursor_tuple_fraction = 1`).
- **`connectOrCreate` no longer deadlocks.** Its upsert locked every existing
  row it met until the transaction ended, so two inserts naming the same tags in
  opposite orders aborted each other (39 of 64 concurrent inserts). An existing
  row is now only read, and rows that have to be created are created in key
  order. Existing rows are no longer rewritten, and no longer use up an identity
  value.
- 2.4.0 regression, node-postgres: a query ordered by a selected expression
  failed with `inconsistent types deduced for parameter $1` when the same bare
  `sql` value stood in the select list and in `where`. A bare parameter is no
  longer shared between clauses.
- 2.4.0 regression: `page()` cursors issued by 2.3.0 were refused for queries
  whose SQL 2.4.0 had made faster. The cursor's fingerprint is now taken from
  the plain form of the query, so it survives such changes; cursors issued by
  2.3.0 work again. Cursors issued by 2.4.0 itself for those queries (two
  aggregates of one relation, an ordering by a selected expression) are refused
  once.
- 2.4.0 regression: a bulk insert whose values in one column exceeded 1 GB
  closed the connection, since one array is one protocol message. Above 128
  million characters the insert goes row by row in pieces, as before 2.4.0.
- 2.4.0 regression: a custom type that encodes to a `Date` failed for years
  before 1 and after 9999 in bulk inserts of 100 rows or more; on Bun it failed
  below 100 rows as well. Both forms now send the text PostgreSQL reads.
- A chunked `upsert()` let the later of two duplicate keys win silently when the
  keys only met after the column rounded them (two instants of one second in a
  `timestamptz(0)` key). Timestamp keys are compared at the column's precision,
  and `…+00:00` equals `…Z`.
- A JavaScript number in a `numeric` column lost digits on Bun in inserts below
  100 rows (`0.1 + 0.2` was stored as `0.3`). Numbers are sent as their exact
  text.
- Full-text `search()` returned rows of equal rank in a different order on every
  call; ties are now broken by the primary key. Each list also sends its
  question once instead of three times, which halves the slowdown Bun's prepared
  statements show on a frequent word (a generic plan computed the rank twice).
- `forUpdate` / `forShare` on a read from a CTE locked nothing, as PostgreSQL
  defines it, without a word; it is now an error.
- **Full-text `search()` keeps its document in a stored generated column**
  (`<search>Words`, hidden like the embedding) instead of an expression index.
  Ranking parsed the text of every matching row again: a search for a common
  word that matched 115 thousand of 300 thousand documents took 0.5 s, and on
  Bun 2.4 s after the fifth call, when PostgreSQL stops spreading the work over
  several cores. It now takes 40 ms, and 0.2 s on Bun after the fifth call.
  **This needs a migration**: `symmetria-kit generate` adds the column and moves
  the GIN index to it; adding the column rewrites the table once.
- `$close()` ends open streams instead of waiting for their loops: a loop that
  called `$close()` waited for itself forever. A loop that stops there ends
  quietly; one that reads on fails with "the database was closed while this
  stream was open". A stream read by other code while the database is being
  closed now fails the same way instead of holding the close back.
- An IVFFlat index declared in the schema no longer comes up short of rows under
  a filter either: it reads on past its nearest lists (pgvector 0.8), and the
  statement sorts the rows once more, since that mode returns them only roughly
  in order.
- A unique index declared in the schema options (`schema(defs, { indexes })`) is
  a key in the types: `find({ tenant, cover })` and `by.<index>` compile.
- `$close()` called inside a `$transaction()` of the same database waited
  forever; it is now an error.
- `column.asc.desc` (outside the types) silently dropped the ordering; it is now
  an error. `over()` refuses unknown options (`partition` for `partitionBy`)
  instead of ignoring them, and a `partitionBy` that is not a list.
- `get()` and `find()` types: an object with a column beside the key, or with
  two keys at once, is a type error (it was refused only at run time), and so is
  a `prepare()` parameter, which a lookup that runs at once cannot wait for. A
  unique index on a descending column is a key for lookups and
  `connectOrCreate`, in the types as well; a unique index with an expression
  among its keys no longer makes its other columns a key in the types. The
  errors about a missing or composite primary key no longer name `byId()` when
  `get()` or `find()` was called.
- A query through the database itself from inside transactions that hold every
  connection of the pool (with `max: 1`, any `db.…` call inside
  `db.$transaction()`) waited forever for a connection its own caller held. It
  is now refused with an error that says to use the transaction's database or
  raise `max`. Such a call that was not awaited used to run after the
  transaction; it is refused as well.
- PostgreSQL 18 reports a `RESTRICT` foreign key with SQLSTATE 23001 instead of
  23503; it is a `ForeignKeyViolation` (`kind: "foreign-key"`) there too.
- Values of the wrong JavaScript type, which only code outside the types can
  send, are refused the same way on both drivers and in both insert forms
  instead of depending on them: a number or string in a `boolean` column, a
  boolean in an `integer` column, a number in a `date`, `timestamp` or
  `timestamptz` column.
- `QueryError.column` on Bun was a number (the engine's source position) when
  PostgreSQL named no column; it is `undefined`.
- `search()`: an empty question finds nothing without asking the model, a vector
  of the wrong size is refused with the expected size, and a zero byte in the
  question no longer fails the BM25 search.
- `where: { embedding: [...] }` compares a vector column with the vector.
- An invalid `Date` in a `date` column is refused instead of being sent as
  `0NaN-NaN-NaN`. In array literals a boolean is `true` / `false`, as in a plain
  parameter.
- A bulk insert keeps the array form when a `jsonb`, `real` or `vector` column
  is NULL in every row.

### Kit (`symmetria-kit`)

- A migration that only widens a column (`numeric(14,2)` to `numeric(16,2)`, a
  longer `varchar`, `varchar` to `text`) no longer drops and recreates the
  indexes and checks on it. PostgreSQL changes such a column in place, so the
  migration of a large table no longer rebuilds its indexes under a lock.
- Stored generated columns (those of full-text searches) are created, compared
  by `drift`, and dropped and added again around a change of the columns they
  are computed from, which PostgreSQL does not allow in place. `lint` reports
  the table rewrite as a caution and never counts such a column as lost data.
- `lint` said an enum "is rebuilt" when the migration only adds labels with
  `ALTER TYPE … ADD VALUE`; it now says which of the two happens.

## 2.4.0 — 2026-11-16

### Runtime (`symmetria`)

- An ordering by a selected field repeats the field with the same SQL text and
  the same parameters, as grouped queries already did. PostgreSQL then
  recognises one expression and computes it once per row: a list sorted by a
  relation aggregate without `limit` ran about a fifth faster on a 3-million-row
  table (37 ms to 30 ms). A filter that repeats a selected expression shares its
  parameters too, so a pgvector query that selects, filters and orders by one
  distance sends the vector once instead of three times.
- Aggregates over one relation with one filter are computed by one subquery:
  `user.orders.count()`, `user.orders.sum.total`, `user.orders.average.total`
  and `user.orders.maximum.createdAt` in one shape read a user's orders once
  instead of four times. A table of 8,925 customers with these four totals over
  3 million orders went from 276 ms to 150 ms, and a page of 50 from 19 ms to 12
  ms, the time of the hand-written `LATERAL` join. The subquery is joined only
  where it cannot cost more: when every row is returned, or after a page has
  been cut; a query limited and sorted by a total keeps per-row subqueries.
- `get()` and `find()` without a shape compile their statement once per table
  and key and only bind the key afterwards, in transactions too: the client cost
  of such a read went from 3.4 µs to 0.3 µs, that of a prepared query. Scoped
  tables, tables with computed fields, `$batch` and profiled drivers take the
  ordinary path.
- A bulk `insert()` or `upsert()` of 100 rows or more whose rows carry the same
  columns as plain values is sent as one array per column
  (`INSERT … SELECT * FROM unnest(…)`). 20,000 rows with a `jsonb` column went
  from about 260 ms to about 210 ms, the time of the same statement written by
  hand, and are one statement instead of two, since the parameter count no
  longer grows with the rows. Inserts with defaults per row, SQL expressions,
  enums or array columns keep `VALUES`.
- `some()`, `none()` and `every()` take a list of predicates joined by `AND`,
  like `where`: `user.orders.some((order) => [order.status.is.paid, …])`. Falsy
  entries are skipped.
- `count()`, `sum()` and the other aggregates no longer allocate a wrapper for
  `.over()` on every call (2.3.0 added about 1 µs to every query that counts a
  relation).

## 2.3.0 — 2026-11-16

### Runtime (`symmetria`)

- `get()` and `find()` read a row by a unique key given as an object of its
  columns, `db.users.get({ email })` or
  `db.handles.find({ tenant: "team", handle: "ada" })` for a unique index over
  two columns, next to the primary key's value. A table without a primary key
  but with a unique key has both methods now. An object that is not a key of the
  table rejects with a message that lists the table's keys; for a composite
  primary key given incompletely this message replaces the former
  `byId() requires exactly these key fields`.
- A CTE or a derived table given options and no fields reads all its fields, as
  a table does: `await ranked({ where: (post) => post.position.atMost(3) })`.
  The types already allowed this call, and it threw
  `select fields in a shape before compiling or executing a query` when it ran.
- Aggregates have `.over()`, like the ranking functions:
  `sum(post.views).over({ partitionBy, orderBy })`, also on `count`, `average`,
  `minimum` and `maximum`. `over(sum(post.views), options)` is unchanged.
- `column.asc` and `column.desc` are short for `ascending` and `descending`, and
  an `orderBy` object accepts `"ascending"` and `"descending"` next to `"asc"`
  and `"desc"`.

### Documentation

- The reference, guide, READMEs and examples use one spelling throughout: `db`
  for the database, a singular row name in callbacks, `await` without
  `.execute()`, slots (`one`, `maybe`, `many`) for relations, `get()` / `find()`
  for reads by key, the `where` option for UPDATE and DELETE, column names in
  `returning()`, and `{ selected }` for selected fields. The earlier relation
  spelling has its own section in the reference.

## 2.2.0 — 2026-11-16

### Runtime (`symmetria`)

- `table(...).search((row) => ({ about: { words, meaning } }))` declares what a
  table is searched by, and
  `db.table.search(shape?, { about: "question", where, limit })` ranks its rows
  by words, by meaning, or by both merged by reciprocal rank fusion, in one
  statement. `words` is `fullText()` (PostgreSQL's own) or `bm25()` (the
  `pg_search` extension); `meaning` is an embedding model: `voyage4` and others
  from `symmetria/voyage`, `ollama("bge-m3")` from `symmetria/ollama`, or
  `embedder(size, fn)` from `symmetria/search`.
- A search by meaning keeps its embedding in a hidden column: `insert()`,
  `upsert()` and nested inserts compute it before the statement is sent, an
  `UPDATE` of the embedded text clears it, and `db.table.search.reindex()`
  computes the missing ones.
- Ready embedding models, each calling its service's HTTP API without a
  dependency: `symmetria/voyage`, `symmetria/openai`, `symmetria/cohere`,
  `symmetria/google`, `symmetria/mistral`, `symmetria/jina` and, for local
  models, `symmetria/ollama`.
- `symmetria/better-auth`: a better-auth database adapter,
  `betterAuth({ database: symmetriaAdapter(db) })`. `npx auth generate` writes
  the auth tables as Symmetria `table()` declarations, plugin tables included.
- The extensions a search needs (`vector`, `pg_search`) are recorded without
  `extensions: [...]` in the schema options.
- `index(...).using("bm25")` for `pg_search` indexes.

### Kit (`symmetria-kit`)

- Migrations, `drift` and `pull` handle `bm25` indexes and the column and
  indexes a `.search()` declaration creates.

## 2.1.0 — 2026-11-16

### Runtime (`symmetria`)

- `in()` / `notIn()` with more than 1,000 values on a `varchar(n)` or
  `numeric(p,s)` column no longer cut or round the listed values to the column's
  length or scale before comparing. Before, `code.in([...])` on `varchar(5)`
  matched `'abcde'` for a listed `'abcdefgh'`, and a `delete().where(...)` with
  such a list could remove rows that were not listed. Bound values are now cast
  to the base type (`varchar[]`, `numeric[]`).
- `match()` returns literal branches whole when another branch is a `varchar(n)`
  or `numeric(p,s)` column (`"Draft (unpublished)"` came back as `"Draft"`), and
  so does a prepared parameter selected as a field.
- An array element longer than a `varchar(n).array` column allows is refused by
  PostgreSQL on write instead of being cut silently.
- A value cast to a `char(n)` column's type keeps its characters: the cast is to
  `bpchar`, since plain `char` means `char(1)`.
- An upsert recognises two spellings of one key: `"1"` and `"1.0"` on a
  `numeric` key (also values that round to the same number at the column's
  scale), a UUID in either letter case, a `char(n)` value with or without
  padding. Before, such rows failed inside PostgreSQL in one statement, and in a
  large insert split into several statements the later row silently replaced the
  earlier one.
- `in()` and `notIn()` reject a `null` in the list where the query is built:
  `NOT IN (…, NULL)` matches no row. Combine the list with `is(null)` or
  `isNot(null)`.
- The `symmetria/pg` adapter sets `DateStyle` to ISO on every new connection.
  With another style set for the database or role (`SQL, DMY`), timestamps read
  as `null` or with day and month swapped, and page cursors were refused.
- Relations are declared on both sides: a slot on the referenced table
  (`posts: many`, `profile: one`, `comments: many.cascade`) and a key that
  claims it (`author: one(users.posts)`, `editor: maybe(users.edited)`,
  `parent: maybe(self.children)`). The slot is a typed property of its table, so
  a wrong name is an error on that line. `one()` and `maybe()` index the key
  (`.noIndex` opts out) and take `.cascade`, `.restrict`, `.setNull`, `.unique`,
  `.by()` and `.column()`. The earlier spellings (`author: users`,
  `users.index`, `.inverse()`, `self`, `junction()`) are unchanged, declare the
  same tables and can be mixed with slots.
- `tags: many(tags.posts)` declares a many-to-many relation and creates its
  junction table (`posts_tags`, `db.postsTags`), with `.with({ … })` for its own
  columns, `.named()` and `.restrict`. `link(posts.tags, tags.posts, { … })`
  declares that junction by itself, and `link({ a: users, b: teams })` is
  `junction()` whose rows go with either side.
- `db.users.get(id)` and `db.users.find(id)` read one row by primary key, whole
  or through a shape; `find()` returns `null` when there is none.
- A query given options and no fields reads the whole row:
  `await db.users({ where: { active: true } })`. A bare table still does not
  execute. In a shape, `(post, { row }) => ({ ...row, author: … })` spreads the
  source's columns.
- `where` takes an object of equalities
  (`{ state: "published", editorId: null }`) and `orderBy` an object of
  directions (`{ spent: "desc" }`) over selected fields and columns. The
  selected fields are also among the tools of `orderBy`, `groupBy` and `having`
  callbacks: `(user, { selected }) => …`.
- Predicates chain:
  `views.above(10).and(state.is.published.or(pinned.is(true)))`.
- `db.orders.aggregate((order, { sum }) => ({ total: sum(order.amount) }))`
  returns one object.
- Nested inserts read the rows they `connect` together and write rows that only
  connect in one multi-row INSERT: twenty posts connecting twenty authors are 2
  statements instead of 40 (about three times faster), and an order whose items
  each connect a product costs about what the same statements written by hand
  do.
- `db.$batch((db) => [db.users.get(id), db.posts({ … }), db.posts.count()])`
  sends several reads as one statement: one round trip and one snapshot of the
  data, on both drivers, inside transactions and under `$scope()`. `$batch` is
  now a reserved table name.
- `update(values, { where })` and `delete({ where })` take the filter as an
  option; an object that names no column is refused instead of writing every
  row.
- `upsert(row, { by: "sku" })` inserts or overwrites the row with that key, with
  `update: [...]` to choose the columns.
- `returning("id", "name")` and `returning()` (the whole row).
- Queries and writes have `catch()` and `finally()` next to `then()`.
- Errors are classes: `NotFoundError`, `TooManyRowsError`, `OutOfScopeError` and
  `DuplicateConflictKeyError` extend `SymmetriaError` (same `code` and message
  as before), and database failures from the built-in adapters are
  `UniqueViolation`, `ForeignKeyViolation`, `NotNullViolation`,
  `CheckViolation`, `ExclusionViolation`, `SerializationFailure`,
  `DeadlockDetected`, `ConnectionError` or `QueryError`, with `kind`,
  `sqlState`, `table`, `column`, `constraint` and `detail`.
- A keyed link keeps its `by()` column type after `.nullable`, `.unique` and
  `.index`.

### Changes to note when upgrading

- A database error from `symmetria/pg` or `symmetria/bun` is now a `QueryError`
  that wraps the driver's error (`error.cause`) and copies its fields. Code that
  compared it with the driver's error object by identity, or read `error.name`
  or `error.constructor`, sees the new class; `sqlState()`, `databaseError()`,
  `error.code` and the message are unchanged.
- `symmetria pull` writes foreign keys as `one(users)` / `maybe(users)` with
  slots on the referenced tables, and a junction whose keys both cascade as
  `link({ … })`. Schemas pulled earlier keep working as they are.

### Kit (`symmetria-kit`)

- `pull` writes the relation syntax above: `author: one(users).cascade`,
  `editor: maybe(users.inverse("postsByEditor")).noIndex.setNull`, and
  `posts: many` on the referenced table.
- `generate` and `diff` see a changed CHECK or index expression when only a
  literal's kind or type changed: a number against the same digits as a string
  (`doc -> 0` and `doc -> '0'`), or the same text as `timestamptz` and
  `timestamp`, or as `jsonb` and `json`.
- A column changed between `timestamptz` and `timestamp` converts with
  `USING "column" AT TIME ZONE 'UTC'` in both directions. The plain cast used
  the time zone of the session that ran the migration. An array column
  (`timestamptz[]` ↔ `timestamp[]`) is converted with the session's zone set to
  UTC around the statement (`SET TIME ZONE 'UTC'` … `RESET TIME ZONE`).
- `rollback` in a terminal reverts exactly the migrations its confirmation
  showed: if another process changed the journal in between, it stops before
  running any SQL. `runner.rollback({ expected: [...] })` does the same from
  code.
- A driver whose pool has one connection can no longer be mistaken for a pinned
  session behind a transaction-mode pooler: without a second connection to
  check, the runner locks per transaction and refuses `transaction: "none"`
  migrations, naming `max: 2` as the fix.
- `drift` no longer reports `char(n)` and `decimal(p,s)` columns as changed
  (PostgreSQL prints `character(n)` and `numeric(p,s)`), and it reports a column
  whose type was replaced by a type of the same name from another schema.
- `repair --snapshot <file>` verifies a boundary against the snapshot of that
  point (`meta/snapshot.json` from version control), so a failed `--online`
  migration can be retried without a `--verify-url` server; the error for a
  missing one names both options.
- `rollback` asks for the database name before `TRUNCATE`, `DROP SCHEMA` and
  `DROP OWNED` as well, and no longer misses a `DROP TABLE` that follows a
  comment.

## 2.0.0 — 2026-11-15

### Changes to note when upgrading

- `symmetria rollback` no longer runs unasked. In a terminal it lists the
  statements of `down.sql` that remove data or database objects and waits for a
  yes; a rollback that drops tables needs the database name typed out. Without a
  terminal (scripts, CI) it exits with code 1 unless `--yes` is passed.
- In the dashboard and in questions, a digit only moves the selection; Enter
  runs the selected action.
- `generate` asks for `--allow-destructive` when a column changes from an
  integer type to `boolean` (every non-zero value becomes `true`) or to a
  narrower integer type (`bigint` → `integer`, `bigint` / `integer` →
  `smallint`), where values that no longer fit make the migration fail.
- The default 10-minute statement timeout no longer applies to
  `transaction: "none"` migrations, so it cannot cancel a long
  `CREATE INDEX CONCURRENTLY` and leave an invalid index. A timeout set with
  `--statement-timeout` or `statementTimeoutMs` still applies.
- A plain object is no longer accepted as a raw SQL default: write
  ``.default(sql`now()`)``. `.default({ kind: "sql", sql: "…" })` on a `jsonb`
  column now stores that object as the JSON value it is.
- A transaction no longer runs the `$scope()` callbacks of tables it does not
  touch; `$scope()` itself still runs the callbacks it is given once, so a
  callback that cannot be a filter fails there.
- Tables named `$scope` or `then` are rejected as reserved names.

### Runtime (`symmetria`)

- Order, group and filter by a selected field without writing its expression
  again: `orderBy`, `groupBy` and `having` callbacks receive the projection's
  fields as a third argument
  (`orderBy: (user, tools, selected) => selected.spent.descending`).
- Nested inserts write sibling children in one statement: an order with three
  items is 2 INSERTs instead of 4, and 22,000 children are 3 statements instead
  of 22,001. Many-to-many link rows are batched as well.
- `dateTrunc(unit, value, { timeZone })` buckets timestamps and dates by day,
  week, month and the other PostgreSQL units.
- `column.set(key, value)` on `jsonb` columns changes one key (or a nested path)
  and keeps the rest of the document.
- Text that is not a number (`"abc"`) for a `numeric` column is rejected before
  the statement is sent, in writes, filters, lists, prepared parameters and
  arithmetic, with a message that shows the value.
- A scoped query built once and then used inside another `$scope()` callback
  (`documents: (d) => d.organizationId.in(allowed)`) reads the current values of
  its own scope on every execution. Before, it kept the values from the moment
  it was built, so reads, updates and deletes could run for the previous tenant.
- Starting a transaction or calling `$scope()` on a large schema is far cheaper:
  about 50 times on 100 tables (an empty transaction went from 0.4 ms to under
  0.01 ms of CPU). Table handles are created on first use.
- A JSON default shaped like `{ kind: "sql", sql }` is stored as a value; only a
  `sql` template is a raw SQL default.
- `column.is` and `column.isNot` behave like ordinary functions (`.call`,
  `.bind`, `.name`); on enum columns only the declared labels are predicates.
- A page cursor is accepted or refused the same way whether the query object is
  reused or built again; it no longer depends on the current `$scope()` values.
- A CTE used only in `doUpdate(…, { where })` no longer fails with an internal
  error.
- A column of another query inside `lag()` / `lead()` is rejected when the query
  is built.
- A projection field left as an uncalled relation, tool or callback gets an
  error that names the field and says to call it or select one of its fields.
- `page()` notices a window function wrapped in `searchRank()`,
  `searchHeadline()` or `searchDocument()`, so later pages no longer compute the
  window only over the rows after the cursor.
- On tables whose primary key is declared in a different order than its columns,
  updates and deletes through a relation path, nested `connect` and
  `connectOrCreate` list the key columns in the declared key order. The
  statements are equivalent; only the column order in the SQL text changes.
- A CHECK or index expression with an unsupported part names that part in its
  error ("cannot contain length()") instead of always blaming aggregates,
  subqueries or placeholders.
- Schema error messages no longer say "experiment".
- `@types/bun` is declared as an optional peer dependency for `symmetria/bun`.

### Kit (`symmetria-kit`)

- `rollback` asks before it runs (see above); `--yes` skips the question.
- The dashboard's "Rollback latest migration" goes through the same question, so
  one mistyped key can no longer drop a column or, after `squash`, every table.
- A migration that failed outside a transaction can be fixed in its own files:
  `status`, `migrate` and `repair` no longer answer "checksum mismatch" for an
  incomplete migration whose `up.sql` or `down.sql` was edited. `migrate` still
  refuses and names the incomplete migration, `repair` verifies the schema as
  before, and the journal takes the checksum of the files that finally ran.
  Applied migrations stay protected against edits.
- Editing a CHECK or a partial-index condition by adding a cast that changes the
  value (`::varchar(3)`, `1.9::integer`) is detected as a schema change instead
  of "No schema changes".
- SQL lint no longer skips statements that mention a table or column named
  `rename`, and schema lint no longer reports the indexes and checks of a
  renamed table or column as new.
- A column, table or index named `concurrently` no longer forces
  `transaction: "none"`; `REFRESH MATERIALIZED VIEW CONCURRENTLY` may run in a
  transaction; `CREATE` / `DROP DATABASE`, `CREATE` / `DROP TABLESPACE` and
  `ALTER SYSTEM` now require `transaction: "none"`.
- `pull` reports what it cannot declare instead of leaving it out silently:
  table inheritance, row-level security, functions and procedures, free-standing
  or shared sequences, and tables in other schemas (codes `inheritance`,
  `row-security`, `function`, `sequence`, `other-schema`). A sequence shared by
  several columns no longer gets the identity fix that would drop it.
- `drift` on a database that is behind the local chain (after `rollback`, or
  before `migrate`) says so instead of listing the pending changes as drift, and
  checks the applied state when `--verify-url` is set; JSON output gains
  `behind`.
- The live profiler shows the error message of a failed request.
- "Created" shows the migrations directory relative to the working directory,
  and long lines wrap after a space or `/` instead of in the middle of a word.

## 1.2.0 — 2026-11-14

### Runtime (`symmetria`)

- `$scope()` values are no longer frozen into reused or prepared queries: every
  execution (reads, `update()` / `delete()`, upserts, lookups, nested relations)
  binds the scope's current values, so a prepared query never reads or writes
  another tenant's rows.
- Scoped databases check every row they write, like row-level security's
  `WITH CHECK`: flat, bulk, chunked and nested inserts, both upsert paths,
  `update()` and lookup updates that would leave a row outside the scope fail
  with `SYMMETRIA_OUT_OF_SCOPE` (naming the table) and write nothing. The check
  runs in the same statement, and unscoped SQL is unchanged. A scoped
  `doUpdate(values, { where })` that conflicts with a row outside the scope
  throws too, while a false condition inside the scope still skips the row; a
  violation caught inside `$transaction` is reported as `SYMMETRIA_OUT_OF_SCOPE`
  by later operations and by the transaction.
- One rule for when errors surface: mistakes in a query's shape throw where the
  query is built, problems with the values it carries (NULL for NOT NULL,
  invalid `jsonb(schema)` input, out-of-range numbers, invalid `Date`s,
  duplicate upsert keys, …) reject its promise when it runs, for reads and
  writes alike. `toSQL()` throws both kinds; prepared queries check values on
  every execution.
- A CTE can no longer take a table's SQL name (`.cte("posts")` throws), so it
  can no longer silently replace that table in the statement.
- `jsonb(schema)` stores the schema's input and runs transforms once, on read;
  inserts and updates are typed with the schema's input type. JS `null` on a
  non-nullable `jsonb` column is stored as JSON `null`.
- `driver.session()` closes its connection afterwards, so its settings, advisory
  locks, temporary tables and any transaction left open never reach other
  queries.
- Operations on a transaction or session run one at a time in call order:
  `Promise.all` of queries, chunked bulk inserts and nested inserts work, and
  node-postgres no longer warns about overlapping queries. An operation still
  pending when a `$transaction` callback returns rejects ("…it was rolled back")
  instead of resolving; a `stream()` left open counts as unfinished work.
- node-postgres: a connection lost in the middle of a query is discarded instead
  of failing the next query; `databaseError()` reports lost connections as
  `kind: "connection"` on both drivers.
- Both drivers read and write values alike: `int[]` / `real[]` from Bun.SQL,
  `real` as PostgreSQL prints it (`0.1`), `-0`, PostgreSQL's `date` forms (years
  before 1000, BC, `infinity`), BC timestamps, and `timestamptz` instants that
  no longer shift by seconds in a non-UTC process time zone. `real` parameters
  compare correctly on Bun.SQL.
- Prepared `first()`, `one()` and `maybeOne()` work with a parameterized
  `limit`.
- A `.one()` relation without a foreign key resolves to the first match by
  primary key in every form, instead of repeating rows or failing with "more
  than one row".
- Upserts with duplicate conflict keys reject with
  `SYMMETRIA_DUPLICATE_CONFLICT_KEY` at any size, instead of silently keeping
  the last duplicate in large inserts.
- JSON paths support `like()` / `ilike()`, arithmetic and `sum()` / `average()`.
  `minimum()` / `maximum()` work on JSON values (ordered as jsonb: numbers
  numerically, strings as text, JSON null skipped), booleans, `uuid`, `bytea`,
  `tsvector` and `vector`, in plain, grouped, relation and window aggregates.
- `jsonb(schema)` filters, `contains()`, paths, `coalesce()` fallbacks and
  prepared parameters are typed with the schema's input, which is what
  PostgreSQL stores and compares; reads still return the output. Results take
  the schema's declared output type, and a hand-written schema whose `validate`
  returns plain object literals is no longer read as `| undefined`.
- `divide()` never truncates: integers and bigints divide as an exact `Decimal`;
  the new `quotient()` divides toward zero in the integer type (`div()` for
  decimals, `trunc()` for floats). Every arithmetic result is typed as
  PostgreSQL returns it, and floats compute in double precision on both drivers.
- Types match results throughout: `count()` and ranking functions in arithmetic
  are `bigint`, `sum()` / `average()` reject text, `coalesce()` and
  `whereNotNull()` treat JSON null as null, `searchRank()`, `searchHeadline()`
  and vector distances are nullable when their input is, and `match()` literals
  take the column branch's type.
- Paths into a relation's, a selected query's or a CTE's nested result read a
  `jsonb(schema)` field like the column itself: the field returns its output and
  compares its input, and paths inside it follow the stored (input) keys and
  values.
- Enum labels and `match()` literals that look like numbers (`oneOf("1", "2")`)
  stay text: no arithmetic or `sum()`, and filters and writes accept only the
  labels. Only `numeric` values and decimal-text operands are `Decimal`;
  arithmetic on text, enum, date or uuid expressions throws where the query is
  built.
- Schema: `oneOf(...).typeName("Role")` names an enum type, shared by every
  column that names it; `text.collate("C")` sets a column's collation;
  `int.auto.byDefault` declares `GENERATED BY DEFAULT AS IDENTITY`; checks and
  partial indexes accept boolean expressions such as ``sql`${t.price} > 0` ``.
  Derived index and check names over 63 bytes are shortened with a hash instead
  of throwing.
- `in()` / `notIn()` accept subqueries over nullable columns, `$transaction`
  accepts a callback that returns a query, and `symmetria/pg` type declarations
  no longer need `@types/pg`.
- The profiler endpoint answers paths that start with `//` with 404 instead
  of 500.
- `$transaction` retries wait at most one second between attempts (or
  `retryDelayMs` when that is longer); the wait used to double without limit, so
  20 retries under contention could take hours.
- Transaction poolers such as PgBouncer are documented: queries, transactions,
  streams and prepared queries work on both drivers. Bun.SQL needs
  `prepare: false` unless the pooler tracks named statements, and before
  PostgreSQL 18 `search_path` belongs on the role, not in the URL.

### Kit (`symmetria-kit`)

- `generate` treats type changes that cut or round existing values (a shorter
  `varchar`, fewer decimal places, a lower timestamp precision) as destructive,
  and alters string lengths without a truncating cast, so PostgreSQL refuses
  values that do not fit instead of silently shortening them.
- An enum label added by one migration can be used by the next one in the same
  `migrate`, on a fresh database and in `verify`: the migration that adds it
  commits first, on every driver. Custom drivers that only run whole
  transactions run each group in its own transaction under
  `pg_advisory_xact_lock`, re-reading the journal, and support `each` mode.
- `squash` refuses to drop SQL that generate did not write (seeds, views, edited
  `up.sql`) and lists it; `--allow-custom-sql` confirms. `adopt` on a database
  without history asks for `--to` instead of recording data-only migrations that
  never ran.
- `status` and `lint --pending` no longer wait for a running `migrate`, and fail
  after 2 seconds with a clear message if the journal is locked.
- Migration SQL keeps `BEGIN ATOMIC … END` function bodies and
  `CREATE RULE … DO ALSO (…; …)` together; rollback of a rename with a `using`
  hint works; checksums ignore CRLF line endings.
- `lint` ignores comments and strings, checks every action of an `ALTER TABLE`,
  blocks `CHECK` / foreign keys added without `NOT VALID`, knows more volatile
  defaults, and no longer flags renames, enum type renames, new enum labels,
  column default changes or key rebuilds after a type change.
- New `ignoreTables` config option and `--ignore-table` flag for `drift`,
  `adopt`, `repair`, `verify` and `pull`; the CLI always leaves out
  `_prisma_migrations` (pull still lists it). A table the schema declares is
  always compared.
- `pull` declares CHECK constraints, partial-index predicates and computed index
  keys as predicates (`users.score.between(1, 10)`,
  `and(t.status.is("active"), t.deletedAt.is(null))`) whenever PostgreSQL stored
  the form the DSL writes, and keeps `sql` for the rest. `diff` and `generate`
  compare conditions and index expressions by meaning, so a DSL schema migrated
  and pulled back needs no migration (`above(-100)` and `> '-100'::integer` are
  the same check).
- `pull` keeps Prisma's enum names (`.typeName()`), reports `_AB_pkey` junction
  keys, declares collations, index ordering and storage options, binds tables
  named like builders (`date`, `text`) under another name, and gives back the
  same schema when run on a database built from its own output. Its serial fix
  continues after the existing rows and the old sequence, keeps explicit ids
  working (`BY DEFAULT`) and drops the old sequence. Migrations, `drift` and
  `pull` handle collations and named enums (created once, labels added in place,
  renamed with `ALTER TYPE … RENAME TO`).
- CLI: every command prints one JSON object with `--json`, `diff` / `lint`
  accept `--online`, Ctrl-C and SIGTERM exit with 130 / 143, and `--help`, the
  README and the reference list the same flags. `--json` failures print JSON,
  migration errors include PostgreSQL's DETAIL, `recover` reports when there is
  nothing to recover, `migrate --to` an applied migration says where the
  database stands, `inspect` shows index predicates, `INCLUDE` and operator
  classes, and the schema browser marks `BY DEFAULT` identities.
- `migrate`, `rollback`, `adopt`, `repair` and `--plan` detect a connection that
  pools transactions (PgBouncer in transaction mode) and then lock each
  transaction with `pg_advisory_xact_lock`; `transaction: "none"` migrations are
  refused there before anything runs. If the session still moves between server
  connections mid-run, the run stops with a clear message.
- `drift`, `pull` and `verify` treat a PostgreSQL 18 `NOT NULL … NOT VALID`
  column as nullable, since old rows may still hold NULL.
- Terminal screens: `inspect` shows named enum types, collations and
  `identity by default`; `diff` names the collation, identity generation or enum
  type that changed and shows an enum rename as one change; SQL tabs number
  source lines; the profiler shows plan trees and fits narrow terminals; `q`
  closes the schema browser.

### Changes to note when upgrading

- Scoped writes that put a row outside the scope (an insert for another tenant,
  an `update()` that changes the tenant column) now fail with
  `SYMMETRIA_OUT_OF_SCOPE`; write such rows through the unscoped database.
  `toSQL()` of scoped inserts and updates ends with a
  `RETURNING … AS "__symmetria_scope"` check and binds the scope values again.
- Builder calls no longer throw for bad values: `insert(bad)`, `update(bad)` and
  filters with invalid values return a query whose promise rejects. Code or
  tests that expected a synchronous throw must `await` / `.catch()` the query,
  or call `toSQL()`.
- Arrays with NULL elements, fractional or out-of-range numbers for `int` /
  `smallint` and invalid `Date`s now fail with the same Symmetria error on both
  drivers instead of passing through or failing differently.
- `toSQL().parameters` shows `timestamptz` values as ISO strings.
- Automatic indexes of `.named()` columns and of `.column()` references with
  uppercase names are named after the SQL column, so the next `generate` renames
  them once (`ALTER INDEX … RENAME`).
- `jsonb(schema)` writes, filters, paths and prepared parameters expect the
  schema's input type; code that used the transformed output type needs the
  input form (the `as never` cast is no longer needed).
- `quantity.divide(2)` returns a `Decimal` such as `"3.5000000000000000"`
  instead of `3`; use `quotient()` for integer division. A JS number next to an
  `int` / `smallint` / `bigint` operand must be an integer in range (write
  fractions as decimal text, `"1.5"`), and arithmetic on a plain `sql<T>`
  template needs `sql.of(column)`.
- `QueryColumn` takes a third type parameter for column traits; annotations such
  as `QueryColumn<number, "x">` no longer accept `real`, double or JSON columns.
  Search ranks and vector distances on nullable inputs are typed `| null`.
- `CHECK` and foreign keys added without `NOT VALID` are blocking `lint`
  findings, so `lint` exits with code 1 for them.
- `--json` output of `drift`, `lint`, `status`, `--plan`, `inspect --relations`
  and `profile` is an object (`findings`, `migrations`, `steps`, `tables`,
  `requests`) instead of a bare array; Ctrl-C and SIGTERM exit with 130 / 143
  instead of 1.
- On a transaction-only custom driver, a failed later group leaves earlier
  groups committed, as on the official drivers.
- `verify` no longer skips a table the schema declares when `ignoreTables` lists
  it.
- Through a transaction-mode pooler, migrations no longer take a session lock,
  and `--online` / `transaction: "none"` migrations must run over a direct or
  session-pooled connection. A migrator driver limited to one connection waits
  up to one second per run for the pooling check; give it two connections.
- On PostgreSQL 18, `drift` reports `nullability-mismatch` for columns whose NOT
  NULL constraint is NOT VALID, and `pull` declares them `.nullable`.

## 1.1.0 — 2026-11-09

### Runtime (`symmetria`)

- Any SQL names: `schema(…, { casing: "preserve" })` keeps keys as SQL names
  (`createdAt`, `authorId`), `.named("User")` sets a table's name and
  `.named("LEGACY_CODE")` a column's, and `.column()` accepts any identifier.
  Constraint and index names follow the SQL names, which matches the names
  Prisma creates. Tables or columns that would share a SQL name are rejected.
- Columns are created in declaration order, foreign keys included, as the
  documentation promised; snapshot hashes ignore column order, so no migration
  results.
- Foreign keys declare `ON UPDATE` with `.onUpdate.cascade`, `.restrict` or
  `.noAction`.
- `timestamp` (without time zone) with UTC semantics on both drivers, and a
  precision for both timestamp builders: `timestamp(3)`, `timestamptz(3)`.
- Exact arithmetic: `plus`, `minus`, `multiply` and the new `divide` accept
  numbers, bigints, decimal text and other numeric columns and follow
  PostgreSQL's promotion, with the casts in the SQL: `quantity.multiply(price)`
  is a decimal, fractional numbers do not truncate. `numeric` values, `sum()`
  and `average()` are typed `Decimal` (decimal text); writes, filters and
  prepared parameters accept any string. On non-numeric columns the type error
  names the method and what it needs.
- Predicate lists skip every falsy entry, so `[q && title.ilike(q)]` type-checks
  for `q: string | undefined` and an empty `q` adds no filter.
- `databaseError(error)` describes server errors the same way on node-postgres
  and Bun.SQL (`kind`, `sqlState`, `table`, `column`, `constraint`, `detail`).
  `one()` and `maybeOne()` errors name the source and carry
  `SYMMETRIA_RECORD_NOT_FOUND` or `SYMMETRIA_TOO_MANY_ROWS`.
- Editors show the resolved value type of nullable columns and columns with
  defaults (`"cart" | "paid"`) instead of `ColumnValue<Column<…>>`.

### Kit (`symmetria-kit`)

- `pull` declares tables and columns under any names, choosing the `casing` that
  fits most of them and adding `.named()` for the rest, so PascalCase and
  camelCase databases such as Prisma's no longer lose tables or columns.
- `pull` declares `ON UPDATE CASCADE` / `RESTRICT` foreign keys, `timestamp(n)`
  columns, and unique indexes named like constraints as `.unique` with an
  `ADD CONSTRAINT … USING INDEX` fix; it lists views, materialized views and
  triggers, and skips Prisma's `_prisma_migrations` with a warning.
- DDL, diff and drift handle `ON UPDATE`.
- The reference documents the `--diff` file format, `self`, SQL names and the
  move from Prisma.

## 1.0.2 — 2026-11-08

### Runtime (`symmetria`)

- `count()` and `exists()` called directly on a scoped table or a bare alias
  (`scoped.posts.count()`, `scoped.posts.as("p").exists()`) evaluate the
  `$scope()` callbacks again, like every other query; they used the values
  captured when the database was scoped, so a changed tenant id counted and
  checked the previous tenant's rows.

### Kit (`symmetria-kit`)

- The `bin` entry is written in the form npm publishes, so publishing no longer
  warns about it.

## 1.0.1 — 2026-11-08

### Runtime (`symmetria`)

- Query building is about 40% cheaper and point lookups twice as cheap: plan
  records are frozen only under `SYMMETRIA_FREEZE=1` (the unit suite runs with
  it), top-level queries reuse their table's root binding and column handles,
  and quoted identifiers are cached. Shared objects that reach application code
  (column handles, query and aggregate prototypes, shape tools) stay frozen. A
  column handle taken from one plain query of a table is now accepted in another
  plain query of the same table; other aliases, transactions and scoped
  databases still reject it.
- `$scope()` callbacks run each time a query or write is built: `update()`,
  `delete()` and upserts of a scoped database read the scope's current values
  instead of the ones captured when `$scope()` was called.
- Streaming closes its cursor and ends the transaction without hiding the
  original error: a failing `CLOSE` or `COMMIT`, a failed rollback and a
  connection that cannot be acquired are reported as such.
- Nested JSON results prepare their row decoder once per result instead of
  checking it for every row.
- Relation names that a column would shadow: explicitly chosen names
  (`.inverse()`, overrides, `relations()`) are rejected when the schema is
  built; automatic reverse and many-to-many names are left out instead of being
  silently unreachable.
- `relations()` predicates, UPDATE values, RETURNING and `$scope()` callbacks
  see columns only and report unknown columns and relation paths with the table,
  the member and a suggestion instead of failing on `undefined`; a predicate
  that compares a third table names the relation and both tables; `to()`
  explains that it expects a table rather than a reference chain; selecting a
  predicate explains that predicates are not values.
- Automatic indexes on `.column()` keys are named after the SQL column, like the
  foreign-key constraint (`posts_author_email_idx`).

## 1.0.0 — 2026-11-08

First stable release of `symmetria` and `symmetria-kit`.

### Runtime (`symmetria`)

- Schema declaration in TypeScript: tables, columns, defaults, enums, JSONB with
  Standard Schema validation, computed fields, indexes, primary keys, CHECK
  constraints and foreign keys that declare both relation directions.
- `count()` and `exists()` on tables, filtered sources and lookups; prepared
  SELECTs keep `one` / `maybeOne` / `first` / `count` / `exists` / `inspect`;
  keyset pages move backward with `page({ before })` and carry `previousCursor`;
  conditional upserts with `doUpdate(values, { where })`; `InferUpdate`;
  `returning()` callbacks receive the scalar tools.
- First-class `smallint`, `real`, `doublePrecision`, `date`, `time`, `interval`,
  `bytea` and `inet` columns with codecs that agree across both drivers; `pull`
  declares them instead of `customType()`.
- References to unique columns and custom key columns:
  `author: users.by("email").column("author_email")` stores the referenced
  column's value under its type, joins and nested `connect` use that column, and
  `pull` declares such foreign keys instead of demoting them.
- Condition relations:
  `table({...}).relations((post, { to }) => ({ author: to(users).one((user) => post.authorName.is(user.name)) }))`
  joins tables by a predicate instead of a foreign key, with paths, nested
  collections, aggregates, quantifiers, explicit JOINs and `.inverse()`; nothing
  is added to DDL, migrations, drift or `pull`.
- Shape-first queries: destructured projections plus a separate options object
  (`where`, `orderBy`, `limit`, `offset`, `groupBy`, `having`, `distinct`,
  `forUpdate`, `forShare`), options-only calls, nested collections with
  per-parent filters, ordering and limits, relation paths that infer their
  JOINs, explicit JOIN helpers whose aliases option callbacks can refer back to,
  tenant scopes, aliases, derived tables, CTEs and recursive CTEs.
- Developer experience: `numeric` and `varchar` usable bare or called; schema
  errors name the table and column and explain builders passed without a call;
  unknown columns or relations in shapes suggest the closest name; predicate
  lists skip `undefined`, `null` and `false`; `Infer`, `InferInsert` and
  `InferShape` type aliases; `$transaction` retries serialization failures with
  `retries` / `retryDelayMs`; `stream()` iterates any query through a
  server-side cursor.
- pgvector through `symmetria/vector`: `vector(n)` columns written as plain
  number arrays, `l2Distance` / `cosineDistance` / `innerProduct` /
  `l1Distance`, operator classes and storage parameters on indexes
  (`operatorClass()`, `.with()`, `hnsw` / `ivfflat`) and schema-level
  `extensions` that migrations create first.
- Relation aggregates as properties (`posts.sum.views`) or callbacks, `count`,
  `exists`, `some` / `none` / `every` quantifiers, window functions, subqueries,
  full-text search (stored `tsvector` columns, weighted `searchDocument()` with
  a matching GIN index, websearch / plain / phrase / raw parsers, `ts_rank`
  options and `ts_headline`), arrays and typed JSON paths.
- Result types inferred all the way down, including nullable JOINs, reusable
  projections and enum mappings. `bigint`, `numeric`, timestamps and custom
  codecs keep their precision inside nested JSON.
- Writes: typed `RETURNING` with reusable projections, upserts, atomic nested
  inserts, bulk INSERTs split under the wire-protocol parameter limit, and
  direct UPDATE / DELETE through `byId()` and unique-key lookups. Whole-table
  writes require an explicit `.all()`.
- Callable prepared queries, keyset pagination with verified cursors and
  `pages()` iteration, transactions with savepoints, isolation options, row
  locks, sessions with cancellation and graceful shutdown.
- PostgreSQL adapters for Bun (`symmetria/bun`) and node-postgres
  (`symmetria/pg`, aliased as `symmetria/driver`) sharing one compiler, codecs
  and transaction lifecycle. Node.js 24.11+ and Bun 1.4.4+; PostgreSQL 14+.
- Query inspector (`query.inspect()`), request profiler with a token-protected
  loopback endpoint, and SQL plus parameters on every query via `toSQL()`.

### Kit (`symmetria-kit`)

- Migration generation from schema snapshots into reviewable `up.sql` /
  `down.sql`, explicit rename hints, destructive-change gating, SQL and schema
  lint for blocking or rewriting statements.
- Journaled execution with advisory locks, lock and statement timeouts,
  cancellation, `batch` / `each` / `none` transaction modes, online DDL,
  `incomplete` state with verified `repair`, `recover` for crashed file
  publication, squash and adopt.
- Drift detection against the live catalog and `verify`, which replays install,
  upgrade, rollback and reapply in disposable databases.
- `symmetria pull` introspects an existing PostgreSQL schema into a Symmetria
  schema module, with a review list (and SQL fixes) for everything the DSL
  cannot express; `pullSchema()` exposes the same programmatically.
- `symmetria.config.ts` may import the schema without a file extension on Node;
  the CLI resolves `./src/schema` to `.ts`, `.js` or an index file.
- `symmetria graph` renders the schema as a Mermaid entity-relationship diagram
  for READMEs and pull requests (`schemaGraph()` / `renderMermaid()`).
- Interactive terminal tools: schema browser, migration dashboard, query
  inspector and live profiler; `symmetria init` scaffolding; a `testDatabase()`
  helper for isolated test schemas.

### Project

- Reproducible PostgreSQL benchmarks against Drizzle, Kysely, Prisma and raw SQL
  (five independent passes, hashed raw evidence kept with the run), a README
  hero and Kit recordings captured from real runs, CI on PostgreSQL 14 and 17,
  `SECURITY.md` and Dependabot.
