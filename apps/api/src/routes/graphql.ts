/**
 * GraphQL route — thin mount point (Hono migration, Phase 2).
 *
 * Mounts `POST /api/v1/graphql` (admin complex reads only, queries
 * only, additive — REST reads stay). The Yoga setup lives in
 * `../graphql/server.ts`; this file only wires the route, following
 * the routes/ convention (`register<Name>Routes`).
 *
 * Auth: the middleware chain resolves `c.var.principal`; a null
 * principal is a 401 here, and each query enforces its own REST
 * permission inside its resolver (customers.read / orders.read /
 * products.read).
 */
import { Hono } from "hono";
import type { AppEnv } from "../types/context.ts";
import { handleGraphQLRequest } from "../graphql/server.ts";

export function registerGraphQLRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/graphql", async (c) => {
    const principal = c.var.principal;
    const requestId = c.var.requestId;
    if (!principal) {
      return c.json(
        {
          success: false,
          error: { code: "UNAUTHORIZED", message: "Authentication required." },
          meta: { request_id: requestId },
        },
        401,
      );
    }
    return handleGraphQLRequest(c.req.raw, {
      store: c.var.store,
      principal: c.var.principal,
      env: c.var.env,
      requestId: c.var.requestId,
    });
  });
}
