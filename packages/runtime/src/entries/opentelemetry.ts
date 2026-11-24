/**
 * `symmetria/opentelemetry`: spans for statements, transactions and savepoints,
 * reported to a tracer of `@opentelemetry/api` that the application passes in.
 */
export {
  traced,
  type TracingOptions,
  type TracingTracer,
  type TracingSpan,
} from "../observability/tracing";
