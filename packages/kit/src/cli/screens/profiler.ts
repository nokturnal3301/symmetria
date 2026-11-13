/**
 * Live profiler screen: polls a running profiler endpoint and renders request and query timings.
 */
import { emitKeypressEvents } from "node:readline";
import type { ProfiledRequest, ProfiledQuery } from "symmetria";
import { fitLine, terminalWidth, theme, wrapLines } from "../ui/style";
import { withScreen } from "../ui/terminal";
import { explainLines, wrapExplainLines } from "./query-inspector";

/** Why the profiler endpoint refused a request, with the fix for a wrong token. */
export const profilerHttpError = (status: number): string =>
  status === 403
    ? "symmetria: the profiler rejected the token; pass --profile-token or set SYMMETRIA_PROFILE_TOKEN to the value used by profiler.serve()"
    : `symmetria: profiler returned HTTP ${status}`;

export const profileScreen = async (
  address: string,
  token: string,
  color: boolean,
): Promise<void> =>
  withScreen(
    () =>
      new Promise<void>((resolve, reject) => {
        const { style, brand } = theme(color);
        let requests: ProfiledRequest[] = [];
        let selectedRequest = 0;
        let selectedQuery = 0;
        let mode: "requests" | "queries" | "sql" | "plan" = "requests";
        let offset = 0;
        let error = "";
        // The plan tree, as the query inspector shows it.
        let plan: string[] = [];
        let closed = false;
        let pending = false;
        let activeRequest: ProfiledRequest | undefined;
        const wasRaw = process.stdin.isRaw;

        const milliseconds = (value: number) => `${value.toFixed(3)} ms`;

        const query = (): ProfiledQuery | undefined =>
          activeRequest?.queries[selectedQuery];

        const draw = () => {
          const height = Math.max(1, (process.stdout.rows || 24) - 7);
          const selected = query();
          const lines: string[] = [];

          // Narrow terminals shorten labels and drop columns rather than
          // cutting the timings off.
          const width = terminalWidth();
          const labelWidth = Math.max(12, Math.min(42, width - 35));
          const compact = width < 72;

          if (mode === "requests") {
            lines.push(
              style(
                `${"Request".padEnd(labelWidth + 3)}SQL    Build     Total`,
                "muted",
              ),
            );
            const start = Math.max(0, selectedRequest - height + 2);

            for (const [position, request] of requests
              .slice(start, start + height - 1)
              .entries()) {
              const duplicates =
                request.queries.length -
                new Set(request.queries.map((entry) => entry.sql)).size;
              lines.push(
                style(
                  `${start + position === selectedRequest ? "›" : " "} ${fitLine(request.label, labelWidth).padEnd(labelWidth)} ${String(request.queries.length).padStart(3)}  ${request.buildMs.toFixed(2).padStart(7)}  ${request.durationMs.toFixed(2).padStart(7)}${duplicates ? `  ↻ ${duplicates}` : ""}${request.error ? "  ERROR" : ""}`,
                  start + position === selectedRequest ? "selected" : "text",
                ),
              );
            }

            if (!requests.length) {
              lines.push(
                "Waiting for queries… Send a request to your application.",
              );
            }
          } else if (mode === "queries") {
            lines.push(
              style(
                `${activeRequest!.label} · build ${milliseconds(activeRequest!.buildMs)} · total ${milliseconds(activeRequest!.durationMs)}`,
                "pink",
              ),
            );
            lines.push(
              style(
                compact
                  ? `${"Query".padEnd(18)}${"Database".padStart(10)} ${"Rows".padStart(6)}`
                  : "Query                       Compile       Database       Decode    Rows",
                "muted",
              ),
            );
            const start = Math.max(0, selectedQuery - height + 3);

            for (const [position, entry] of activeRequest!.queries
              .slice(start, start + height - 2)
              .entries()) {
              const marker = start + position === selectedQuery ? "›" : " ";
              lines.push(
                style(
                  compact
                    ? `${marker} ${entry.kind.padEnd(7)} #${String(entry.id).padEnd(6)} ${entry.databaseMs.toFixed(3).padStart(10)} ${String(entry.rows).padStart(6)}${entry.error ? " ERROR" : ""}`
                    : `${marker} ${entry.kind.padEnd(9)} #${String(entry.id).padEnd(10)} ${entry.compileMs.toFixed(3).padStart(9)} ${entry.databaseMs.toFixed(3).padStart(14)} ${entry.decodeMs.toFixed(3).padStart(12)} ${String(entry.rows).padStart(7)}${entry.error ? " ERROR" : ""}`,
                  start + position === selectedQuery ? "selected" : "text",
                ),
              );
            }
          } else {
            const wrapped =
              mode === "plan"
                ? wrapExplainLines(plan, terminalWidth())
                : wrapLines(
                    `${selected!.sql}\n\nParameters\n${JSON.stringify(selected!.parameters, null, 2)}${selected!.error ? `\n\n${selected!.error}` : ""}`,
                  );
            offset = Math.min(offset, Math.max(0, wrapped.length - height));
            lines.push(...wrapped.slice(offset, offset + height));
          }

          process.stdout.write(
            `\u001b[H\u001b[2J  ${fitLine(`${brand()} ${style("/ live profiler", "muted")}`)}\n  ${style(fitLine(error || address), error ? "danger" : "muted")}\n\n${lines.map((line) => `  ${fitLine(line)}`).join("\n")}\u001b[${Math.max(1, (process.stdout.rows || 24) - 1)};1H  ${style(fitLine("↑ ↓ navigate · enter open · esc back · e explain · a analyze · q quit"), "muted")}`,
          );
        };

        const refresh = async () => {
          if (pending || closed) {
            return;
          }

          pending = true;

          try {
            const response = await fetch(new URL("/requests", address), {
              headers: { "x-symmetria-token": token },
              signal: AbortSignal.timeout(3000),
            });

            if (!response.ok) {
              throw new Error(profilerHttpError(response.status));
            }

            const updated = (await response.json()) as ProfiledRequest[];

            if (!Array.isArray(updated)) {
              throw new Error("Invalid profiler response");
            }

            const selectedId = requests[selectedRequest]?.id;
            requests = updated.toSorted((left, right) => right.id - left.id);
            selectedRequest = Math.max(
              0,
              requests.findIndex((entry) => entry.id === selectedId),
            );
            error = "";
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          } finally {
            pending = false;

            if (!closed) {
              draw();
            } else {
              resolve();
            }
          }
        };

        const explain = async (analyze: boolean) => {
          const selected = query();

          if (!selected || pending) {
            return;
          }

          pending = true;
          error = analyze
            ? "Running EXPLAIN ANALYZE…"
            : "Estimating query plan…";
          draw();

          try {
            const response = await fetch(
              new URL(`/explain?id=${selected.id}&analyze=${analyze}`, address),
              {
                method: "POST",
                headers: { "x-symmetria-token": token },
                signal: AbortSignal.timeout(30000),
              },
            );
            const result = await response.json();

            if (!response.ok) {
              throw new Error(
                result && typeof result === "object" && "error" in result
                  ? String(result.error)
                  : `HTTP ${response.status}`,
              );
            }

            plan = Array.isArray(result) ? explainLines(result) : [];

            if (!plan.length) {
              plan = JSON.stringify(result, null, 2).split("\n");
            }

            mode = "plan";
            offset = 0;
            error = "";
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          } finally {
            pending = false;

            if (!closed) {
              draw();
            } else {
              resolve();
            }
          }
        };

        const finish = () => {
          if (closed) {
            return;
          }

          closed = true;
          clearInterval(timer);
          process.stdin.off("keypress", keypress);
          process.stdin.off("end", finish);
          process.stdout.off("resize", draw);
          process.stdin.setRawMode(wasRaw);
          process.stdin.pause();

          if (!pending) {
            resolve();
          }
        };

        const keypress = (
          input: string,
          key: { name?: string; ctrl?: boolean },
        ) => {
          if (input === "q" || (key.ctrl && key.name === "c")) {
            finish();

            return;
          }

          if (key.name === "escape" || key.name === "left") {
            if (mode === "requests") {
              finish();

              return;
            }

            mode = mode === "queries" ? "requests" : "queries";
            offset = 0;
          } else if (key.name === "return") {
            if (mode === "requests" && requests[selectedRequest]) {
              activeRequest = requests[selectedRequest];
              selectedQuery = 0;
              mode = "queries";
            } else if (mode === "queries" && query()) {
              mode = "sql";
              offset = 0;
            }
          } else if (input === "e" || input === "a") {
            if (mode !== "requests") {
              void explain(input === "a");
            }
          } else if (
            ["up", "down", "pageup", "pagedown"].includes(key.name ?? "")
          ) {
            const direction =
              key.name === "up" || key.name === "pageup" ? -1 : 1;
            const step = key.name?.startsWith("page") ? 10 : 1;

            if (mode === "requests") {
              selectedRequest = Math.max(
                0,
                Math.min(
                  requests.length - 1,
                  selectedRequest + direction * step,
                ),
              );
            } else if (mode === "queries") {
              selectedQuery = Math.max(
                0,
                Math.min(
                  activeRequest!.queries.length - 1,
                  selectedQuery + direction * step,
                ),
              );
            } else {
              offset = Math.max(0, offset + direction * step);
            }
          }

          draw();
        };

        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("keypress", keypress);
        process.stdin.once("end", finish);
        process.stdout.on("resize", draw);
        process.stdout.write("\u001b[?25l");
        const timer = setInterval(() => {
          void refresh();
        }, 500);
        draw();
        void refresh().catch(reject);
      }),
  );
