import { describe, expect, it } from "vitest";
import { EnvTokenStore } from "../../src/auth/tokenStore/envTokenStore.js";
import { createTokenStore } from "../../src/auth/credentialProvider.js";
import { authorizeHttpRequest } from "../../src/http/auth.js";
import { handleHealth, handleHttpRoute } from "../../src/http/routes.js";
import type { Config } from "../../src/config/env.js";
import { loadConfig } from "../../src/config/env.js";

describe("loadConfig", () => {
  it("throws when required Google env vars are missing", () => {
    const original = { ...process.env };
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;

    expect(() => loadConfig()).toThrow(/GOOGLE_CLIENT_ID/);

    process.env = original;
  });

  it("loads config with valid env vars", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.MCP_TRANSPORT = "stdio";
    process.env.LOG_LEVEL = "info";
    delete process.env.PORT;

    const config = loadConfig();
    expect(config.google.clientId).toBe("test-client-id");
    expect(config.mcp.transport).toBe("stdio");
    expect(config.limits.maxEmailBodyBytes).toBeGreaterThan(0);

    process.env = original;
  });

  it("falls back to PORT when MCP_PORT is unset", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    delete process.env.MCP_PORT;
    process.env.PORT = "8080";
    process.env.MCP_AUTH_TOKEN = "test-auth-token";

    const config = loadConfig();
    expect(config.mcp.port).toBe(8080);

    process.env = original;
  });

  it("uses Railway PORT and ignores MCP_PORT when PORT is set", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.MCP_PORT = "4000";
    process.env.PORT = "8080";
    process.env.MCP_AUTH_TOKEN = "test-auth-token";

    const config = loadConfig();
    expect(config.mcp.port).toBe(8080);

    process.env = original;
  });

  it("ignores MCP_TRANSPORT=stdio when PORT is set (Railway)", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.MCP_TRANSPORT = "stdio";
    process.env.MCP_HOST = "127.0.0.1";
    process.env.PORT = "8080";
    process.env.MCP_AUTH_TOKEN = "test-auth-token";

    const config = loadConfig();
    expect(config.mcp.transport).toBe("streamable-http");
    expect(config.mcp.host).toBe("0.0.0.0");
    expect(config.mcp.port).toBe(8080);

    process.env = original;
  });

  it("defaults to streamable-http and 0.0.0.0 when PORT is set", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_HOST;
    delete process.env.MCP_PORT;
    process.env.PORT = "8080";
    process.env.MCP_AUTH_TOKEN = "test-auth-token";

    const config = loadConfig();
    expect(config.mcp.transport).toBe("streamable-http");
    expect(config.mcp.host).toBe("0.0.0.0");
    expect(config.mcp.port).toBe(8080);

    process.env = original;
  });

  it("requires MCP_AUTH_TOKEN for HTTP transport", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.MCP_TRANSPORT = "streamable-http";
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.PORT;

    expect(() => loadConfig()).toThrow(
      "Missing required environment variable: MCP_AUTH_TOKEN",
    );

    process.env = original;
  });

  it("loads GOOGLE_TOKENS_JSON when set", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.GOOGLE_TOKENS_JSON =
      '{"default":{"accessToken":"a","refreshToken":"r","expiryDate":9999999999999}}';

    const config = loadConfig();
    expect(config.google.tokensJson).toContain("refreshToken");

    process.env = original;
  });
});

describe("HTTP authentication", () => {
  const authToken = "correct-auth-token";

  function authenticate(path: string, authorization?: string): Response | null {
    const headers = authorization ? { Authorization: authorization } : undefined;
    return authorizeHttpRequest(
      new Request(`http://localhost:3000${path}`, { headers }),
      authToken,
    );
  }

  it("rejects a request without a token", () => {
    expect(authenticate("/")?.status).toBe(401);
  });

  it("rejects a request with the wrong token", () => {
    expect(authenticate("/", "Bearer incorrect-auth-tok")?.status).toBe(401);
  });

  it("allows a request with the right token", () => {
    expect(authenticate("/", `Bearer ${authToken}`)).toBeNull();
  });

  it("allows /health without a token", () => {
    expect(authenticate("/health")).toBeNull();
  });

  it.each(["/oauth/start", "/oauth/callback?code=test"])(
    "protects %s",
    (path) => {
      expect(authenticate(path)?.status).toBe(401);
    },
  );
});

describe("EnvTokenStore", () => {
  it("loads default principal from flat token object", async () => {
    const store = new EnvTokenStore(
      JSON.stringify({
        accessToken: "access",
        refreshToken: "refresh",
        expiryDate: 123,
      }),
    );

    await expect(store.load()).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiryDate: 123,
    });
  });

  it("persists refreshed tokens in memory", async () => {
    const store = new EnvTokenStore(
      JSON.stringify({
        default: {
          accessToken: "old",
          refreshToken: "refresh",
          expiryDate: 123,
        },
      }),
    );

    await store.save({
      accessToken: "new",
      refreshToken: "refresh",
      expiryDate: 456,
    });

    await expect(store.load()).resolves.toEqual({
      accessToken: "new",
      refreshToken: "refresh",
      expiryDate: 456,
    });
  });
});

describe("createTokenStore", () => {
  it("uses EnvTokenStore when GOOGLE_TOKENS_JSON is configured", () => {
    const store = createTokenStore({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://localhost/callback",
      tokenStorePath: "./tokens.json",
      tokensJson: '{"default":{"accessToken":"a","refreshToken":"r","expiryDate":1}}',
    });

    expect(store).toBeInstanceOf(EnvTokenStore);
  });
});

describe("HTTP routes", () => {
  const config: Config = {
    google: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3000/oauth/callback",
      tokenStorePath: "./tokens.json",
    },
    mcp: {
      transport: "streamable-http",
      host: "127.0.0.1",
      port: 3000,
    },
    logging: { level: "error" },
    limits: {
      maxEmailBodyBytes: 1024,
      maxDocAppendBytes: 1024,
    },
  };

  it("returns health status", async () => {
    const response = handleHealth();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("routes GET /health", async () => {
    const response = await handleHttpRoute(
      "GET",
      new URL("http://localhost:3000/health"),
      config,
      createTokenStore(config.google),
    );

    expect(response?.status).toBe(200);
  });

  it("redirects GET /oauth/start to Google", async () => {
    const response = await handleHttpRoute(
      "GET",
      new URL("http://localhost:3000/oauth/start"),
      config,
      createTokenStore(config.google),
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com/);
  });

  it("returns null for unknown routes", async () => {
    const response = await handleHttpRoute(
      "GET",
      new URL("http://localhost:3000/mcp"),
      config,
      createTokenStore(config.google),
    );

    expect(response).toBeNull();
  });

  it("routes GET /", async () => {
    const response = await handleHttpRoute(
      "GET",
      new URL("http://localhost:3000/"),
      config,
      createTokenStore(config.google),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      service: "google-workspace-mcp-server",
      status: "running",
    });
  });
});
