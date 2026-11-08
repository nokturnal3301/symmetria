import { relative, resolve } from "node:path";
import { formatCreated } from "../ui/format";
import { initializeProject } from "../scaffold";
import type { CliContext } from "../context";

const quoteArgument = (value: string) =>
  /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** `init [directory]`: scaffold schema modules, a connection and migration config. */
export const init = async (
  context: CliContext,
  name: string | undefined,
): Promise<void> => {
  const { style, color } = context;
  const directory = resolve(name ?? ".");
  const files = await context.progress("Creating your project", () =>
    initializeProject(directory),
  );

  if (!files.length) {
    context.emit({
      json: { directory, files },
      plain: () => "Existing project files preserved; nothing to create.",
    });

    return;
  }

  const invocation = "bunx --package symmetria-kit symmetria";
  const changeDirectory =
    directory === process.cwd()
      ? ""
      : `  cd ${quoteArgument(relative(process.cwd(), directory))}\n`;
  const next = `${style("Next", "violet")}\n${changeDirectory}  Set DATABASE_URL (see .env.example)\n  ${style(`${invocation} generate initial`, "accent")}\n  ${style(`${invocation} migrate`, "accent")}`;
  context.emit({
    json: { directory, files },
    pretty: () => `${formatCreated(directory, files, color)}\n${next}`,
    plain: () =>
      `Created\n${files.map((file) => `  ${file}`).join("\n")}\n\n${next}`,
  });
};
