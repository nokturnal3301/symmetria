/** Facade: the compiler lives in ./compile, split by concern. */
export {
  compileQuery,
  compilePlan,
  executePlan,
  executeCompiled,
  quoteIdentifier,
} from "./compile/index";
