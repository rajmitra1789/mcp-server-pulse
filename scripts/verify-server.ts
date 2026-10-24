#!/usr/bin/env tsx
import { config as loadDotenv } from "dotenv";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

loadDotenv();

const EXPECTED_TOOLS = [
  "gmail_create_draft",
  "gmail_send_email",
  "google_docs_append_content",
];

async function createTransport() {
  const mcpUrl = process.env.MCP_URL?.trim();
  if (mcpUrl) {
    const authToken = process.env.MCP_AUTH_TOKEN?.trim();
    if (!authToken) {
      throw new Error("MCP_AUTH_TOKEN is required when MCP_URL is set");
    }

    console.log(`Using HTTP transport: ${mcpUrl}`);
    return new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    });
  }

  const serverPath = resolve("dist/index.js");
  const tokenPath = resolve(process.env.GOOGLE_TOKEN_STORE_PATH ?? "./tokens.json");

  return new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      GOOGLE_TOKEN_STORE_PATH: tokenPath,
      MCP_TRANSPORT: "stdio",
      LOG_LEVEL: "error",
    } as Record<string, string>,
    cwd: process.cwd(),
    stderr: "pipe",
  });
}

async function verifyHealthEndpoint(mcpUrl: string): Promise<void> {
  const healthUrl = new URL("/health", mcpUrl);
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { status?: string };
  if (payload.status !== "ok") {
    throw new Error(`Unexpected health response: ${JSON.stringify(payload)}`);
  }
  console.log("✓ Health endpoint responds");
}

async function main(): Promise<void> {
  const mcpUrl = process.env.MCP_URL?.trim();
  if (mcpUrl) {
    await verifyHealthEndpoint(mcpUrl);
  }

  const transport = await createTransport();
  const client = new Client({ name: "mcp-verify-client", version: "1.0.0" });

  console.log("Connecting to MCP server...");
  await client.connect(transport);

  console.log("✓ Connected\n");

  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name).sort();

  console.log("Discovered tools:");
  for (const name of toolNames) {
    console.log(`  - ${name}`);
  }

  const missing = EXPECTED_TOOLS.filter((t) => !toolNames.includes(t));
  if (missing.length > 0) {
    throw new Error(`Missing expected tools: ${missing.join(", ")}`);
  }
  console.log("\n✓ All 3 expected tools discovered");

  const invalidResult = await client.callTool({
    name: "gmail_create_draft",
    arguments: { to: ["not-an-email"], subject: "Test", body: "Test" },
  });

  const invalidText = invalidResult.content?.find((c) => c.type === "text");
  if (!invalidText || invalidText.type !== "text") {
    throw new Error("Expected text content in invalid input response");
  }

  let validationOk = false;
  try {
    const invalidPayload = JSON.parse(invalidText.text) as {
      ok: boolean;
      error?: { code: string };
    };
    validationOk =
      invalidPayload.ok === false && invalidPayload.error?.code === "INVALID_INPUT";
  } catch {
    validationOk =
      invalidResult.isError === true ||
      /invalid|email/i.test(invalidText.text);
  }

  if (!validationOk) {
    throw new Error(`Unexpected validation response: ${invalidText.text}`);
  }
  console.log("✓ Validation error handling works");

  const draftResult = await client.callTool({
    name: "gmail_create_draft",
    arguments: {
      to: [process.env.TEST_EMAIL_TO ?? "sarora12@gmail.com"],
      subject: `[MCP Verify] ${new Date().toISOString()}`,
      body: "This is an automated MCP server verification draft. Safe to delete.",
      bodyType: "text",
    },
  });

  const draftText = draftResult.content?.find((c) => c.type === "text");
  if (!draftText || draftText.type !== "text") {
    throw new Error("Expected text content in draft response");
  }

  const draftPayload = JSON.parse(draftText.text) as {
    ok: boolean;
    draftId?: string;
    status?: string;
    error?: { code: string; message: string };
  };

  if (draftPayload.ok !== true) {
    throw new Error(
      `Gmail draft creation failed: ${draftPayload.error?.code} — ${draftPayload.error?.message}`,
    );
  }

  console.log(`✓ Gmail draft created (draftId: ${draftPayload.draftId}, status: ${draftPayload.status})`);

  await client.close();
  console.log("\n✅ MCP server verification passed");
}

main().catch(async (error) => {
  console.error("\n❌ MCP server verification failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
