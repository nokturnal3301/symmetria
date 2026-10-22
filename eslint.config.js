import { parser } from "@symmetria/style";

const functionSpacing = {
  meta: { type: "layout", fixable: "whitespace", schema: [] },
  create: (context) => {
    const source = context.sourceCode;

    const check = (node) => {
      const statements = node.body;

      for (let position = 0; position < statements.length - 1; position++) {
        const previous = statements[position];
        const next = statements[position + 1];

        const isFunction = (statement) => {
          const declaration = statement.declaration ?? statement;

          return (
            declaration.type === "VariableDeclaration" &&
            declaration.declarations.some(
              (entry) => entry.init?.type === "ArrowFunctionExpression",
            )
          );
        };

        if (!isFunction(previous) && !isFunction(next)) {
          continue;
        }

        const between = source.text.slice(previous.range[1], next.range[0]);

        if (!/\n\s*\n/.test(between)) {
          context.report({
            node: next,
            message: "Separate function implementations with a blank line.",
            fix: (fixer) => fixer.insertTextAfter(previous, "\n"),
          });
        }
      }
    };

    return { Program: check, BlockStatement: check };
  },
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.cache/**",
      "**/.symmetria-*/**",
      ".build/**",
      "benchmarks/report/**",
    ],
  },
  {
    files: ["**/*.{ts,js}"],
    languageOptions: {
      parser,
      parserOptions: { warnOnUnsupportedTypeScriptVersion: false },
    },
    plugins: {
      conventions: { rules: { "function-spacing": functionSpacing } },
    },
    rules: {
      curly: ["error", "all"],
      "brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "func-style": ["error", "expression", { allowArrowFunctions: true }],
      "prefer-arrow-callback": ["error", { allowNamedFunctions: false }],
      "padding-line-between-statements": [
        "error",
        {
          blankLine: "always",
          prev: "*",
          next: ["return", "if", "for", "while", "switch", "try"],
        },
        {
          blankLine: "always",
          prev: ["if", "for", "while", "switch", "try"],
          next: "*",
        },
      ],
      "conventions/function-spacing": "error",
    },
  },
];
