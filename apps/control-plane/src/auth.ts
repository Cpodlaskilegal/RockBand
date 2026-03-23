import type { FastifyReply, FastifyRequest } from "fastify";

export function buildBearerAuthHook(serviceToken: string) {
  return async function bearerAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.routeOptions.url;
    if (path === "/health" || path === "/healthz" || path === "/readyz" || path === "/internal/worker-events") {
      return;
    }

    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      reply.code(401).send({
        error: {
          code: "missing_auth",
          message: "Missing bearer token",
        },
      });
      return;
    }

    const token = header.slice("Bearer ".length);
    if (token !== serviceToken) {
      reply.code(403).send({
        error: {
          code: "invalid_auth",
          message: "Invalid bearer token",
        },
      });
      return;
    }
  };
}
