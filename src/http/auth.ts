import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

export function authorizeHttpRequest(
  request: Request,
  expectedToken: string,
): Response | null {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return null;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return unauthorizedResponse();
  }

  const providedToken = authorization.slice(BEARER_PREFIX.length);
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return unauthorizedResponse();
  }

  return null;
}

function unauthorizedResponse(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    },
  );
}
