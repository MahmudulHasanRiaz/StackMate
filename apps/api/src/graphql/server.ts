/**
 * GraphQL Yoga setup — admin complex reads only (Hono migration, Phase 2).
 *
 * This file owns ONLY the Yoga server: schema + error masking + the
 * request handler. The route mount lives in `../routes/graphql.ts`
 * (`registerGraphQLRoutes`), per the routes/ convention — this file
 * never touches the Hono app.
 *
 * Queries only in v1; mutations stay REST. Resolvers call the SAME
 * service helpers and store reads as the REST handlers in `../app.ts`.
 */
import { GraphQLError } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import { typeDefs } from "./schema.ts";
import { resolvers, type GraphQLContext } from "./resolvers.ts";

/** Shared schema (built once; a Yoga server is created per request so its
 *  context can close over that request's Hono vars). */
export const graphqlSchema = createSchema({ typeDefs, resolvers });

/**
 * Error masking with an extensions-based pass-through.
 *
 * Yoga's default masker hides every error whose class identity is not
 * yoga's own `GraphQLError` — and under vitest (and any bundler that
 * duplicates the `graphql` package) the `GraphQLError` the resolvers
 * throw is a DIFFERENT module instance, so `instanceof` is false and
 * even intentional errors (NOT_FOUND / FORBIDDEN / VALIDATION_ERROR)
 * were masked to "Unexpected error." (proven by probe 2026-11-25).
 * The contract is therefore the extensions, not the class: an error
 * carrying a known `code` + numeric `statusCode` passes through
 * untouched; anything else is masked to the generic message with no
 * internals leaked.
 */
function maskGraphQLError(error: unknown, message: string): GraphQLError {
  const extensions = (error as { extensions?: Record<string, unknown> } | null)?.extensions;
  if (
    extensions &&
    typeof extensions.code === "string" &&
    extensions.code !== "INTERNAL_SERVER_ERROR" &&
    typeof extensions.statusCode === "number"
  ) {
    return error as GraphQLError;
  }
  return new GraphQLError(message, {
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  });
}

/** One Yoga server for one request (context closes over the Hono vars). */
export function createGraphQLYogaServer(context: GraphQLContext) {
  return createYoga({
    schema: graphqlSchema,
    graphqlEndpoint: "/api/v1/graphql",
    // The admin SPA does not need GraphiQL; CORS is the Hono app's job.
    graphiql: false,
    cors: false,
    maskedErrors: { maskError: maskGraphQLError },
    context: (): GraphQLContext => context,
  });
}

/**
 * Execute one GraphQL request and return the HTTP response.
 * Preserves REST-like status codes for auth/validation failures:
 * resolvers throw with extensions.statusCode; yoga answers 200 by
 * default, so the first error's status is lifted onto the response.
 * A successful query (or a partial-data response) keeps 200.
 */
export async function handleGraphQLRequest(
  request: Request,
  context: GraphQLContext,
): Promise<Response> {
  const yoga = createGraphQLYogaServer(context);
  const yogaResponse = await yoga.fetch(request);
  const bodyText = await yogaResponse.text();
  let status = yogaResponse.status;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const errors = (
      parsed as { errors?: Array<{ extensions?: { statusCode?: unknown } }> }
    ).errors;
    if (Array.isArray(errors)) {
      for (const error of errors) {
        const code = error?.extensions?.statusCode;
        if (typeof code === "number") {
          status = code;
          break;
        }
      }
    }
  } catch {
    // Non-JSON body (should not happen for queries) — keep yoga's status.
  }
  return new Response(bodyText, { status, headers: yogaResponse.headers });
}
