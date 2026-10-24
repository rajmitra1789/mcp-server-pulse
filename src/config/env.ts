import { config as loadDotenv } from "dotenv";
import {
  DEFAULT_MAX_DOC_APPEND_BYTES,
  DEFAULT_MAX_EMAIL_BODY_BYTES,
  createPayloadLimits,
  type PayloadLimits,
} from "./limits.js";

if (process.env.NODE_ENV !== "production") {
  loadDotenv();
}

export type McpTransport = "stdio" | "streamable-http";

export type Config = {
  google: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    tokenStorePath: string;
    tokensJson?: string;
  };
  mcp: {
    transport: McpTransport;
    host: string;
    port: number;
    authToken?: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  limits: PayloadLimits;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : defaultValue;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  return parsed;
}

function parseTransport(value: string): McpTransport {
  if (value === "stdio" || value === "streamable-http") {
    return value;
  }
  throw new Error(`Invalid MCP_TRANSPORT: ${value}. Expected stdio or streamable-http.`);
}

function parseLogLevel(value: string): Config["logging"]["level"] {
  const levels = ["debug", "info", "warn", "error"] as const;
  if ((levels as readonly string[]).includes(value)) {
    return value as Config["logging"]["level"];
  }
  throw new Error(`Invalid LOG_LEVEL: ${value}`);
}

function resolveMcpPort(): number {
  if (isPlatformDeploy()) {
    return parsePositiveInt(process.env.PORT!.trim(), "PORT");
  }

  const mcpPort = process.env.MCP_PORT?.trim();
  if (mcpPort) {
    return parsePositiveInt(mcpPort, "MCP_PORT");
  }

  return 3000;
}

function optionalTokensJson(): string | undefined {
  const value = process.env.GOOGLE_TOKENS_JSON?.trim();
  return value && value !== "" ? value : undefined;
}

function isPlatformDeploy(): boolean {
  return Boolean(process.env.PORT?.trim());
}

function resolveTransport(): McpTransport {
  if (isPlatformDeploy()) {
    return "streamable-http";
  }

  const explicit = process.env.MCP_TRANSPORT?.trim();
  if (explicit) {
    return parseTransport(explicit);
  }

  return "stdio";
}

function resolveHost(): string {
  if (isPlatformDeploy()) {
    return "0.0.0.0";
  }

  const explicit = process.env.MCP_HOST?.trim();
  if (explicit) {
    return explicit;
  }

  return "127.0.0.1";
}

export function loadConfig(): Config {
  const transport = resolveTransport();
  const tokensJson = optionalTokensJson();
  const authToken =
    transport === "streamable-http" ? requireEnv("MCP_AUTH_TOKEN") : undefined;

  return {
    google: {
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
      tokenStorePath: optionalEnv("GOOGLE_TOKEN_STORE_PATH", "./tokens.json"),
      tokensJson,
    },
    mcp: {
      transport,
      host: resolveHost(),
      port: resolveMcpPort(),
      authToken,
    },
    logging: {
      level: parseLogLevel(optionalEnv("LOG_LEVEL", "info")),
    },
    limits: createPayloadLimits(
      parsePositiveInt(
        optionalEnv("MAX_EMAIL_BODY_BYTES", String(DEFAULT_MAX_EMAIL_BODY_BYTES)),
        "MAX_EMAIL_BODY_BYTES",
      ),
      parsePositiveInt(
        optionalEnv("MAX_DOC_APPEND_BYTES", String(DEFAULT_MAX_DOC_APPEND_BYTES)),
        "MAX_DOC_APPEND_BYTES",
      ),
    ),
  };
}

export function loadAuthConfig(): Pick<Config, "google"> {
  return {
    google: {
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirectUri: requireEnv("GOOGLE_REDIRECT_URI"),
      tokenStorePath: optionalEnv("GOOGLE_TOKEN_STORE_PATH", "./tokens.json"),
      tokensJson: optionalTokensJson(),
    },
  };
}
