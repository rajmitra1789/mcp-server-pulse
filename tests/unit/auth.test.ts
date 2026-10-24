import { describe, expect, it } from "vitest";
import { authorizeHttpRequest } from "../../src/http/auth.js";

describe("HTTP bearer authentication", () => {
  const authToken = "correct-auth-token";

  function authenticate(path: string, authorization?: string): Response | null {
    const headers = authorization ? { Authorization: authorization } : undefined;
    const request = new Request(`http://localhost:3000${path}`, { headers });

    return authorizeHttpRequest(request, authToken);
  }

  it("returns 401 when the token is missing", () => {
    expect(authenticate("/")?.status).toBe(401);
  });

  it("returns 401 when the token is wrong", () => {
    expect(authenticate("/", "Bearer wrong-auth-token")?.status).toBe(401);
  });

  it("passes when the token is correct", () => {
    expect(authenticate("/", `Bearer ${authToken}`)).toBeNull();
  });

  it("passes /health without a token", () => {
    expect(authenticate("/health")).toBeNull();
  });
});
