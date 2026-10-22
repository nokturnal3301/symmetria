import { stringWidth } from "bun";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { SchemaSnapshot, TableSnapshot } from "symmetria";
import { fitLine, theme, wrapLines } from "./style";
import {
  highlightSQL,
  inspectEntries,
  inspectTableSQL,
  inspectTabs,
  matchesEntry,
  matchesTableName,
  matchingTables,
  type InspectTab,
} from "./inspect-data";

type InspectOptions = { color: boolean; table?: string; tab?: InspectTab };
type Position = {
  table: TableSnapshot | undefined;
  tab: InspectTab;
  row: number;
  search: string;
  focus: "tables" | "details";
};

/** Runs inside the caller's alternate screen, both standalone and in the dashboard. */
export const inspectSchema = (
  snapshot: SchemaSnapshot,
  options: InspectOptions,
): Promise<void> => {
  const initial = options.table
    ? snapshot.tables.find(
        (table) =>
          table.name === options.table || table.sqlName === options.table,
      )
    : snapshot.tables[0];

  if (options.table && !initial) {
    throw new Error(`symmetria: unknown table "${options.table}"`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("symmetria: schema browser requires a terminal");
  }

  return new Promise((resolve, reject) => {
    const { style, brand } = theme(options.color);
    const position: Position = {
      table: initial,
      tab: options.tab ?? "Columns",
      row: 0,
      search: "",
      focus: options.table ? "details" : "tables",
    };
    const history: Position[] = [];
    const sqlCache = new Map<TableSnapshot, string>();
    let searchStart: Position | undefined;
    let finished = false;
    let previousLines: string[] = [];
    let pageSize = 1;
    let tablePageSize = 1;
    let rowCount = 0;
    const wasRaw = process.stdin.isRaw;

    const tables = () => matchingTables(snapshot, position.search);

    const entries = () =>
      position.table
        ? inspectEntries(position.table, position.tab).filter(
            (entry) =>
              !position.search ||
              matchesTableName(position.table!, position.search) ||
              matchesEntry(entry, position.search),
          )
        : [];

    const align = (text: string, width: number) => {
      const clipped = fitLine(text, width);

      return clipped + " ".repeat(Math.max(0, width - stringWidth(clipped)));
    };

    const frame = (
      title: string,
      body: string[],
      width: number,
      focused: boolean,
    ) => {
      const tone = focused ? "violet" : "border";
      const top = `─ ${title} `;

      return [
        style(
          `╭${fitLine(top, width - 2)}${"─".repeat(Math.max(0, width - 2 - stringWidth(top)))}╮`,
          tone,
        ),
        ...body.map(
          (line) =>
            `${style("│", tone)} ${align(line, width - 4)} ${style("│", tone)}`,
        ),
        style(`╰${"─".repeat(width - 2)}╯`, tone),
      ];
    };

    const rowStyle = (
      line: string,
      selected: boolean,
      focused: boolean,
      width: number,
    ) =>
      selected
        ? style(
            align(stripVTControlCharacters(line), width),
            focused ? "selected" : "accent",
          )
        : align(line, width);

    const normalize = () => {
      const visible = tables();

      if (!position.table || !visible.includes(position.table)) {
        position.table = visible[0];
        position.row = 0;
      }
    };

    const render = () => {
      normalize();
      const width = Math.max(
        1,
        Math.min(process.stdout.columns || 88, 160) - 4,
      );
      const height = process.stdout.rows || 24;

      if (width < 28 || height < 12) {
        return [
          fitLine("  symmetria / inspect", width),
          fitLine("  Enlarge terminal to browse", width),
          fitLine("  Esc to return", width),
        ];
      }

      const visible = tables();
      const selectedTableIndex = Math.max(0, visible.indexOf(position.table!));
      const split = width >= 72;
      const sidebarWidth = split
        ? Math.min(28, Math.max(19, Math.floor(width * 0.23)))
        : width;
      const detailWidth = split ? width - sidebarWidth - 2 : width;
      const innerWidth = detailWidth - 4;
      const innerHeight = height - 7;
      tablePageSize = innerHeight;
      const tableOffset = Math.max(
        0,
        Math.min(
          selectedTableIndex - innerHeight + 1,
          visible.length - innerHeight,
        ),
      );
      const sidebar = visible
        .slice(tableOffset, tableOffset + innerHeight)
        .map((table) => {
          const selected = table === position.table;

          return rowStyle(
            `${selected ? "›" : " "} ${table.name}`,
            selected,
            position.focus === "tables",
            sidebarWidth - 4,
          );
        });

      if (!sidebar.length) {
        sidebar.push(style("No matching tables", "muted"));
      }

      while (sidebar.length < innerHeight) {
        sidebar.push("");
      }

      const selectedEntries = entries();
      const labels =
        innerWidth >= 66
          ? inspectTabs
          : ["Cols", "Rels", "Idx", "Checks", "SQL"];
      const tabs = inspectTabs
        .map((tab, index) => {
          const count =
            position.table && tab !== "SQL"
              ? ` ${inspectEntries(position.table, tab).length}`
              : "";
          const label = `${labels[index]}${count}`;

          return style(
            position.tab === tab ? `[${label}]` : label,
            position.tab === tab ? "pink" : "muted",
          );
        })
        .join("  ");
      const tabLine =
        stringWidth(tabs) <= innerWidth
          ? tabs
          : `${style(`‹ ${position.tab} ›`, "pink")}  ${style(`${inspectTabs.indexOf(position.tab) + 1}/5 · ← → tabs`, "muted")}`;
      const detail: string[] = [
        tabLine,
        style("─".repeat(innerWidth), "border"),
      ];
      let pageLabel = "";

      if (position.tab === "SQL" && position.table) {
        if (!sqlCache.has(position.table)) {
          sqlCache.set(
            position.table,
            highlightSQL(
              inspectTableSQL(snapshot, position.table),
              options.color,
            ),
          );
        }

        const sqlLines = wrapLines(
          sqlCache.get(position.table)!,
          innerWidth - 5,
        );
        pageSize = innerHeight - detail.length;
        rowCount = sqlLines.length;
        position.row = Math.max(0, Math.min(position.row, rowCount - pageSize));
        detail.push(
          ...sqlLines
            .slice(position.row, position.row + pageSize)
            .map(
              (line, index) =>
                `${style(String(position.row + index + 1).padStart(3), "muted")}  ${line}`,
            ),
        );
        pageLabel = `SQL ${position.row + 1}–${Math.min(rowCount, position.row + pageSize)}/${rowCount}`;
      } else {
        const nameWidth = Math.min(
          Math.max(
            10,
            ...selectedEntries.map((entry) => stringWidth(entry.name)),
          ),
          Math.floor(innerWidth * 0.43),
        );
        const typeWidth = Math.min(
          Math.max(
            7,
            ...selectedEntries.map((entry) => stringWidth(entry.kind)),
          ),
          Math.floor(innerWidth * 0.25),
        );

        const entryLine = (name: string, kind: string, flags: string) =>
          `${align(name, nameWidth)}  ${align(kind, typeWidth)}  ${flags}`;

        const detailBudget = Math.min(
          4,
          Math.max(2, Math.floor(innerHeight / 4)),
        );
        pageSize = Math.max(
          1,
          innerHeight - detail.length - 1 - detailBudget - 1,
        );
        rowCount = selectedEntries.length;
        position.row = Math.max(0, Math.min(position.row, rowCount - 1));
        const offset = Math.max(
          0,
          Math.min(position.row - pageSize + 1, rowCount - pageSize),
        );
        detail.push(style(`  ${entryLine("NAME", "TYPE", "FLAGS")}`, "muted"));
        const rows = selectedEntries
          .slice(offset, offset + pageSize)
          .map((entry, index) => {
            const selected = position.row === offset + index;

            return rowStyle(
              `${selected ? "›" : " "} ${entryLine(style(entry.name, "accent"), style(entry.kind, "violet"), entry.badges.map((badge) => style(badge, "pink")).join(" · "))}`,
              selected,
              position.focus === "details",
              innerWidth,
            );
          });

        if (!rows.length) {
          rows.push(
            style(
              position.search
                ? "No matches in this tab"
                : `No ${position.tab.toLowerCase()}`,
              "muted",
            ),
          );
        }

        while (rows.length < pageSize) {
          rows.push("");
        }

        detail.push(...rows, style("─".repeat(innerWidth), "border"));
        const selected = selectedEntries[position.row];
        const description = selected
          ? wrapLines(style(selected.description, "muted"), innerWidth).slice(
              0,
              detailBudget,
            )
          : [
              style(
                position.table
                  ? "← → switch tabs · / search"
                  : "No tables to inspect",
                "muted",
              ),
            ];
        detail.push(...description);
        pageLabel = rowCount
          ? `${position.tab} ${position.row + 1}/${rowCount}`
          : position.tab;
      }

      while (detail.length < innerHeight) {
        detail.push("");
      }

      const sidebarPanel = frame(
        `Tables · ${visible.length}/${snapshot.tables.length}`,
        sidebar,
        sidebarWidth,
        position.focus === "tables",
      );
      const detailPanel = frame(
        position.table?.name ?? "Schema",
        detail.slice(0, innerHeight),
        detailWidth,
        position.focus === "details",
      );
      const panels = split
        ? sidebarPanel.map((line, index) => `${line}  ${detailPanel[index]}`)
        : position.focus === "tables"
          ? sidebarPanel
          : detailPanel;
      const breadcrumb = `${history.length ? `${history.at(-1)!.table?.name} → ` : ""}${position.table?.name ?? "schema"}`;
      const search = searchStart
        ? `${style("/", "pink")} ${position.search}${style("▏", "pink")}  ${style("enter apply · esc cancel", "muted")}`
        : position.search
          ? `${style("/", "pink")} ${position.search}  ${style("esc clear", "muted")}`
          : style("/ search tables and fields", "muted");
      const hint =
        width >= 90
          ? "↑↓ select · Tab pane · ←→ tabs · Enter follow · / search · ⌫ back · Esc exit"
          : width >= 64
            ? "↑↓ select · Tab pane · ←→ tabs · Enter follow · / find · Esc back"
            : "Tab pane · ←→ tabs · / find · Esc back";

      return [
        `  ${fitLine(`${brand()} ${style(`/ inspect / ${breadcrumb}`, "muted")}`, width)}`,
        `  ${fitLine(search, width)}`,
        ...panels.map((line) => `  ${line}`),
        `  ${fitLine(`${style(position.focus === "tables" ? "TABLES" : "DETAILS", "violet")}  ${style(pageLabel, "muted")}${history.length ? style(" · ⌫ previous table", "pink") : ""}`, width)}`,
        `  ${style(fitLine(hint, width), "muted")}`,
      ];
    };

    const draw = () => {
      try {
        const lines = render();
        const changes = lines.flatMap((line, index) =>
          line === previousLines[index]
            ? []
            : [`\u001b[${index + 1};1H\u001b[2K${line}`],
        );

        for (let index = lines.length; index < previousLines.length; index++) {
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
      process.stdin.pause();
      process.stdout.write("\u001b[?25h");

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const end = () => finish();

    const keypress = (
      input: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) {
        return finish();
      }

      if (searchStart) {
        if (key.name === "escape") {
          Object.assign(position, searchStart);
          searchStart = undefined;
        } else if (key.name === "return") {
          searchStart = undefined;
        } else if (key.name === "backspace") {
          position.search = [...position.search].slice(0, -1).join("");
          position.row = 0;
        } else if (key.ctrl && key.name === "u") {
          position.search = "";
          position.row = 0;
        } else if (!key.ctrl && !key.meta && input && !/[\p{C}]/u.test(input)) {
          position.search += input;
          position.row = 0;
        }

        draw();

        return;
      }

      if (input === "/") {
        searchStart = { ...position };
        draw();

        return;
      }

      if (key.name === "escape") {
        if (position.search) {
          position.search = "";
          position.row = 0;
          draw();

          return;
        }

        return finish();
      }

      if (key.name === "tab") {
        position.focus = position.focus === "tables" ? "details" : "tables";
      } else if (key.name === "backspace") {
        const previous = history.pop();

        if (previous) {
          Object.assign(position, previous);
        } else {
          position.focus = "tables";
        }
      } else if (
        key.name === "left" ||
        key.name === "right" ||
        /^[1-5]$/.test(input)
      ) {
        const index = inspectTabs.indexOf(position.tab);
        position.tab =
          inspectTabs[
            /^[1-5]$/.test(input)
              ? Number(input) - 1
              : (index + (key.name === "left" ? -1 : 1) + inspectTabs.length) %
                inspectTabs.length
          ]!;
        position.row = 0;
        position.focus = "details";
      } else if (key.name === "return") {
        if (position.focus === "tables") {
          position.focus = "details";
        } else {
          const target = entries()[position.row]?.target;
          const table =
            target &&
            snapshot.tables.find(
              (table) =>
                table.name === target.table || table.sqlName === target.table,
            );

          if (table) {
            history.push({ ...position });
            Object.assign(position, {
              table,
              tab: "Columns",
              search: "",
              row: Math.max(
                0,
                table.columns.findIndex(
                  (column) =>
                    column.name === target.column ||
                    column.sqlName === target.column,
                ),
              ),
            });
          }
        }
      } else if (
        ["up", "down", "pageup", "pagedown", "home", "end"].includes(
          key.name ?? "",
        )
      ) {
        const visible = tables();
        const maximum =
          position.focus === "tables"
            ? visible.length - 1
            : position.tab === "SQL"
              ? rowCount - pageSize
              : rowCount - 1;
        const current =
          position.focus === "tables"
            ? visible.indexOf(position.table!)
            : position.row;
        const step = position.focus === "tables" ? tablePageSize : pageSize;
        const amount =
          key.name === "up"
            ? -1
            : key.name === "down"
              ? 1
              : key.name === "pageup"
                ? -step
                : step;
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

        if (position.focus === "tables") {
          position.table = visible[next];
          position.row = 0;
        } else {
          position.row = next;
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
  });
};
