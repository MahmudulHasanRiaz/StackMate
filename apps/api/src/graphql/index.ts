/**
 * GraphQL module barrel (admin complex reads only, queries only, additive).
 * Canonical mount: `registerGraphQLRoutes` in `../routes/graphql.ts`.
 */
export { graphqlSchema, createGraphQLYogaServer, handleGraphQLRequest } from "./server.ts";
export { registerGraphQLRoutes } from "../routes/graphql.ts";
export { typeDefs } from "./schema.ts";
export { resolvers } from "./resolvers.ts";
export type { GraphQLContext } from "./resolvers.ts";
