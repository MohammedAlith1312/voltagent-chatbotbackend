import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Create MCP server (stdio – NOT HTTP)
const server = new McpServer({
  name: "status-mcp-server",
  version: "1.0.0",
});

// Define tool schema
const StatusSchema = z.object({
  message: z.string().optional(),
});

// Register tool
server.registerTool(
  "status",
  {
    title: "Status tool",
    description: "Return ok status and current time",
    inputSchema: StatusSchema,
  },
  async ({ message }) => {
   const now = new Date().toLocaleString("en-IN", {
  timeZone: "Asia/Kolkata",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});


    return {
      content: [
        {
          type: "text",
          text: `Status: ok\nTime: ${now}${
            message ? `\nMessage: ${message}` : ""
          }`,
        },
      ],
    };
  }
);

// Start MCP server over stdio
async function main() {
  console.log("✅ MCP SERVER RUNNING (STDIO)");
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("MCP error:", err);
  process.exit(1);
});
