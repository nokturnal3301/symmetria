import { stringWidth } from "bun";
import { emitKeypressEvents } from "node:readline";
import { inspect, stripVTControlCharacters } from "node:util";
import type { QueryInspectionController } from "symmetria/internal";
import { highlightSQL } from "./inspect-data";
import { fitLine, supportsColor, theme, wrapLines } from "./style";
import { withScreen } from "./terminal";

const tabs = ["SQL", "Parameters", "Results", "Explain"] as const;
type Tab = (typeof tabs)[number];

const terminalText = (text: string): string =>
  stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export const inspectValue = (value: unknown, expanded = false): string =>
  terminalText(
    inspect(value, {
      colors: false,
      depth: expanded ? null : 5,
      compact: !expanded,
      breakLength: expanded ? 72 : Infinity,
      maxArrayLength: expanded ? null : 20,
      customInspect: false,
      getters: false,
    }),
  );

export const explainLines = (
  plan: readonly Record<string, unknown>[],
): string[] => {
  const lines: string[] = [];

  const visit = (
    node: Record<string, unknown>,
    prefix: string,
    branch: string,
  ) => {
    const label = [
      node["Node Type"],
      node["Relation Name"],
      node["Index Name"] ? `using ${node["Index Name"]}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const actual =
      node["Actual Total Time"] === undefined
        ? ""
        : ` · actual ${node["Actual Total Time"]} ms × ${node["Actual Loops"] ?? 1}`;
    lines.push(
      `${prefix}${branch}${label} · rows ${node["Plan Rows"] ?? "?"} · cost ${node["Total Cost"] ?? "?"}${actual}`,
    );
    const continuation =
      prefix + (branch === "├─ " ? "│  " : branch ? "   " : "");

    for (const name of [
      "Index Cond",
      "Hash Cond",
      "Merge Cond",
      "Join Filter",
      "Filter",
      "Sort Key",
      "Group Key",
      "Rows Removed by Filter",
      "Shared Hit Blocks",
      "Shared Read Blocks",
    ]) {
      if (node[name] !== undefined) {
        lines.push(
          `${continuation}  ${name}: ${Array.isArray(node[name]) ? node[name].join(", ") : String(node[name])}`,
        );
      }
    }

    const children = Array.isArray(node.Plans) ? node.Plans : [];
    children.forEach((child, index) => {
      if (child && typeof child === "object") {
        visit(
          child,
          continuation,
          index === children.length - 1 ? "╰─ " : "├─ ",
        );
      }
    });
  };

  for (const entry of plan) {
    if (entry.Plan && typeof entry.Plan === "object") {
      visit(entry.Plan as Record<string, unknown>, "", "");
    }

    for (const name of ["Planning Time", "Execution Time"]) {
      if (entry[name] !== undefined) {
        lines.push(`${name}: ${entry[name]} ms`);
      }
    }
  }

  return lines.length ? lines.map(terminalText) : [inspectValue(plan, true)];
};

export const inspectQueryScreen = async (
  inspection: QueryInspectionController,
  color = supportsColor(),
): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "symmetria: interactive query inspection requires a terminal",
    );
  }

  let pending: Promise<void> | undefined;
  await withScreen(
    () =>
      new Promise<void>((resolve, reject) => {
        const { style, brand } = theme(color);
        const { report } = inspection;
        const errors = new Map<Tab, string>();
        let tab: Tab = "SQL";
        let busy: Tab | undefined;
        let offset = 0;
        let columnOffset = 0;
        let expanded = false;
        let detailOffset = 0;
        let pageSize = 1;
        let maximum = 0;
        let finished = false;
        let previousLines: string[] = [];
        const wasRaw = process.stdin.isRaw;
        const wasFlowing = process.stdin.readableFlowing === true;

        const align = (line: string, width: number) => {
          const clipped = fitLine(line, width);

          return (
            clipped + " ".repeat(Math.max(0, width - stringWidth(clipped)))
          );
        };

        const load = (force = false, analyze = false) => {
          if (finished || busy || (tab !== "Results" && tab !== "Explain")) {
            return;
          }

          const requested = tab;

          if (!inspection.connected) {
            errors.set(
              tab,
              "Configure a query executor or driver to use this tab.",
            );

            return draw();
          }

          if (
            (!force &&
              (tab === "Results" ? report.results : report.explanation)) ||
            (!force && errors.has(tab))
          ) {
            return;
          }

          errors.delete(tab);
          busy = tab;
          draw();
          pending = (
            requested === "Results"
              ? inspection.execute()
              : inspection.explain(analyze)
          )
            .catch((error: unknown) => {
              errors.set(
                requested,
                error instanceof Error ? error.message : String(error),
              );
            })
            .finally(() => {
              busy = undefined;

              if (finished) {
                return;
              }

              draw();

              if (tab !== requested) {
                load();
              }
            });
        };

        const render = (): string[] => {
          const width = Math.max(
            1,
            Math.min(process.stdout.columns || 88, 160) - 4,
          );
          const height = process.stdout.rows || 24;

          if (width < 32 || height < 12) {
            return [
              "  symmetria / query",
              fitLine("  Enlarge terminal to inspect", width),
              "  Esc to close",
            ].map((line) => fitLine(line, width));
          }

          const innerWidth = width - 4;
          pageSize = height - 9;
          let body: string[] = [];
          let status = "";
          let lines: string[] = [];
          const error = errors.get(tab);

          if (error) {
            lines = wrapLines(style(terminalText(error), "danger"), innerWidth);
          } else if (busy === tab) {
            lines = [
              style(
                `Running ${tab === "Results" ? "query" : "EXPLAIN"}…`,
                "pink",
              ),
            ];
          } else if (tab === "SQL") {
            lines = wrapLines(
              highlightSQL(terminalText(report.sql), color),
              innerWidth - 5,
            ).map(
              (line, index) =>
                `${style(String(index + 1).padStart(3), "muted")}  ${line}`,
            );
          } else if (tab === "Parameters") {
            lines = report.parameters.flatMap((value, index) => [
              style(
                `$${index + 1}  ${value === null ? "null" : value instanceof Date ? "Date" : Array.isArray(value) ? "array" : typeof value}`,
                "violet",
              ),
              ...wrapLines(inspectValue(value, true), innerWidth).map((line) =>
                style(line, "text"),
              ),
              "",
            ]);

            if (!lines.length) {
              lines = [style("No bound parameters", "muted")];
            }
          } else if (tab === "Explain") {
            lines = report.explanation
              ? wrapLines(
                  expanded
                    ? inspectValue(report.explanation.plan, true)
                    : explainLines(report.explanation.plan).join("\n"),
                  innerWidth,
                )
              : ["No plan loaded"];

            if (report.explanation) {
              status = `${report.explanation.analyzed ? "ANALYZE · actual execution" : "Estimated plan"} · ${report.explanation.durationMs.toFixed(2)} ms`;
            }
          } else if (report.results) {
            const rows = report.results.rows;
            offset = Math.max(0, Math.min(offset, rows.length - 1));
            status = `${rows.length} rows · ${report.results.durationMs.toFixed(2)} ms including decoding`;

            if (!rows.length) {
              lines = [style("Query returned no rows", "muted")];
            } else if (expanded) {
              lines = wrapLines(inspectValue(rows[offset], true), innerWidth);
              status = `Row ${offset + 1}/${rows.length} · ${status}`;
            } else {
              const columns = Object.keys(rows[0]!);
              columnOffset = Math.max(
                0,
                Math.min(columnOffset, columns.length - 1),
              );
              const visible: { name: string; width: number }[] = [];
              let remaining = innerWidth - 2;

              for (const name of columns.slice(columnOffset)) {
                const preferred = Math.min(
                  30,
                  Math.max(
                    10,
                    stringWidth(name),
                    ...rows
                      .slice(offset, offset + pageSize)
                      .map((row) => stringWidth(inspectValue(row[name]))),
                  ),
                );

                if (visible.length && remaining < Math.min(preferred, 12)) {
                  break;
                }

                const size = Math.min(preferred, remaining);
                visible.push({ name, width: size });
                remaining -= size + 2;

                if (remaining < 1) {
                  break;
                }
              }

              const rowLine = (row: Record<string, unknown>, header = false) =>
                visible
                  .map(({ name, width }) =>
                    align(header ? name : inspectValue(row[name]), width),
                  )
                  .join("  ");

              const available = pageSize - 2;
              const start = Math.max(
                0,
                Math.min(offset - available + 1, rows.length - available),
              );
              body = [
                style(`  ${rowLine({}, true)}`, "accent"),
                style("─".repeat(innerWidth), "border"),
                ...rows.slice(start, start + available).map((row, index) => {
                  const line = `${start + index === offset ? "›" : " "} ${rowLine(row)}`;

                  return start + index === offset
                    ? style(align(line, innerWidth), "selected")
                    : line;
                }),
              ];
              maximum = Math.max(0, rows.length - 1);
              status = `Row ${offset + 1}/${rows.length} · columns ${columnOffset + 1}–${columnOffset + visible.length}/${columns.length} · ${report.results.durationMs.toFixed(2)} ms`;
            }
          }

          if (!body.length) {
            maximum = Math.max(0, lines.length - pageSize);

            if (expanded && tab === "Results") {
              detailOffset = Math.min(detailOffset, maximum);
            } else {
              offset = Math.min(offset, maximum);
            }

            const start = expanded && tab === "Results" ? detailOffset : offset;
            body = lines.slice(start, start + pageSize);

            if (!status) {
              status = `${tab} · ${lines.length} lines`;
            }
          }

          while (body.length < pageSize) {
            body.push("");
          }

          const labels = tabs
            .map((name, index) =>
              style(
                tab === name
                  ? `[${index + 1} ${name}]`
                  : `${index + 1} ${name}`,
                tab === name ? "pink" : "muted",
              ),
            )
            .join("  ");
          const tabLine =
            stringWidth(labels) <= width
              ? labels
              : `${style(`‹ ${tab} ›`, "pink")} ${style(`${tabs.indexOf(tab) + 1}/4`, "muted")}`;
          const hints =
            tab === "Results"
              ? "↑↓ rows · h/l columns · Enter details · r run again"
              : tab === "Explain"
                ? "↑↓ scroll · Enter JSON · a analyze · r estimate"
                : "↑↓ scroll · PgUp/PgDn page";
          const hint =
            width >= 100
              ? `←→ tabs · ${hints} · Esc close`
              : width >= 64
                ? `←→ tabs · ${tab === "Results" ? "↑↓ rows · h/l cols · Enter expand" : tab === "Explain" ? "↑↓ scroll · a analyze · Enter JSON" : "↑↓ scroll · PgUp/PgDn"} · Esc close`
                : "←→ tabs · ↑↓ scroll · Esc close";

          return [
            `  ${brand()} ${style("/ query inspector", "muted")}`,
            `  ${style("●", inspection.connected ? "connected" : "muted")} ${style(`${inspection.connected ? "Executor ready" : "Offline"} · SQL ${report.compileMs.toFixed(3)} ms · ${report.parameters.length} parameters`, "muted")}`,
            "",
            `  ${tabLine}`,
            `  ${style(`╭${"─".repeat(width - 2)}╮`, "border")}`,
            ...body.map(
              (line) =>
                `  ${style("│", "border")} ${align(line, innerWidth)} ${style("│", "border")}`,
            ),
            `  ${style(`╰${"─".repeat(width - 2)}╯`, "border")}`,
            `  ${style(fitLine(status || `${tab} · ready`, width), "violet")}`,
            `  ${style(fitLine(hint, width), "muted")}`,
          ].map((line) => fitLine(line, width + 2));
        };

        const draw = () => {
          if (finished) {
            return;
          }

          try {
            const lines = render();
            const changes = lines.flatMap((line, index) =>
              line === previousLines[index]
                ? []
                : [`\u001b[${index + 1};1H\u001b[2K${line}`],
            );

            for (
              let index = lines.length;
              index < previousLines.length;
              index++
            ) {
              changes.push(`\u001b[${index + 1};1H\u001b[2K`);
            }

            process.stdout.write(changes.join(""));
            previousLines = lines;
          } catch (error) {
            finish(error);
          }
        };

        const resize = () => {
          previousLines = [];
          process.stdout.write("\u001b[H\u001b[2J");
          draw();
        };

        const finish = (error?: unknown) => {
          if (finished) {
            return;
          }

          finished = true;
          process.stdin.off("keypress", keypress);
          process.stdin.off("end", end);
          process.stdout.off("resize", resize);
          process.stdin.setRawMode(wasRaw);

          if (!wasFlowing) {
            process.stdin.pause();
          }

          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        const end = () => finish();

        const keypress = (
          input: string,
          key: { name?: string; ctrl?: boolean; shift?: boolean },
        ) => {
          if (
            (key.ctrl && ["c", "d"].includes(key.name ?? "")) ||
            key.name === "escape" ||
            input === "q"
          ) {
            return finish();
          }

          if (
            ["left", "right", "tab"].includes(key.name ?? "") ||
            /^[1-4]$/.test(input)
          ) {
            tab =
              tabs[
                /^[1-4]$/.test(input)
                  ? Number(input) - 1
                  : (tabs.indexOf(tab) +
                      (key.name === "left" || (key.name === "tab" && key.shift)
                        ? -1
                        : 1) +
                      tabs.length) %
                    tabs.length
              ]!;
            offset = 0;
            detailOffset = 0;
            expanded = false;
            draw();
            load();

            return;
          }

          if (input === "r") {
            offset = 0;
            detailOffset = 0;
            load(true);

            return;
          }

          if (input === "a" && tab === "Explain") {
            offset = 0;
            load(true, true);

            return;
          }

          if (key.name === "return" && ["Results", "Explain"].includes(tab)) {
            expanded = !expanded;
            detailOffset = 0;

            if (tab === "Explain") {
              offset = 0;
            }
          } else if (
            (input === "h" || input === "l") &&
            tab === "Results" &&
            !expanded
          ) {
            columnOffset += input === "h" ? -1 : 1;
          } else if (
            ["up", "down", "pageup", "pagedown", "home", "end"].includes(
              key.name ?? "",
            )
          ) {
            const current =
              expanded && tab === "Results" ? detailOffset : offset;
            const amount =
              key.name === "up"
                ? -1
                : key.name === "down"
                  ? 1
                  : key.name === "pageup"
                    ? -pageSize
                    : pageSize;
            const next = Math.max(
              0,
              Math.min(
                maximum,
                key.name === "home"
                  ? 0
                  : key.name === "end"
                    ? maximum
                    : current + amount,
              ),
            );

            if (expanded && tab === "Results") {
              detailOffset = next;
            } else {
              offset = next;
            }
          } else {
            return;
          }

          draw();
        };

        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("keypress", keypress);
        process.stdin.once("end", end);
        process.stdout.on("resize", resize);
        process.stdout.write("\u001b[?25l");
        resize();
      }),
  );
  // Keep a surrounding transaction alive until an already-started request finishes.
  await pending;
};
