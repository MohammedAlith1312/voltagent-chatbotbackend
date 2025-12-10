// backend/agent.ts
import "dotenv/config";
import {
  VoltAgent,
  Agent,
  Memory,
  AiSdkEmbeddingAdapter,
  type BaseMessage,
} from "@voltagent/core";
import {
  PostgreSQLMemoryAdapter,
  PostgreSQLVectorAdapter,
} from "@voltagent/postgres";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { honoServer } from "@voltagent/server-hono";

import { weatherTool, calculatorTool, getLocationTool } from "./tools";
import { ingestDocumentText, searchDocumentsByQuery } from "./vector-store";
import { initDocumentVectorTable } from "./db-init";

// ---------- OpenRouter for CHAT ----------
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  headers: {
    "HTTP-Referer": "https://voltagent-chatbotbackend.onrender.com",
    "X-Title": "voltagent-app",
  },
});

// ---------- OpenRouter for EMBEDDINGS (memory) ----------
const openrouterForEmbeddings = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
  name: "openrouter",
  headers: {
    "HTTP-Referer":
      "https://voltagent-chatbotbackend.onrender.com/agents/sample-app/chat",
    "X-Title": "voltagent-app",
  },
});

const embeddingModel =
  openrouterForEmbeddings.embedding("text-embedding-3-small");

// ---------- MEMORY (conversation history + semantic recall) ----------
export const memory = new Memory({
  storage: new PostgreSQLMemoryAdapter({
    connection: process.env.DATABASE_URL!,
  }),
  embedding: new AiSdkEmbeddingAdapter(embeddingModel),
  vector: new PostgreSQLVectorAdapter({
    connection: process.env.DATABASE_URL!,
  }),
});

// ---------- AGENT ----------
export const agent = new Agent({
  name: "sample-app",
  model: openrouter.chat("amazon/nova-2-lite-v1:free"),
  tools: [weatherTool, calculatorTool, getLocationTool],
  memory,
  instructions: `
You are a helpful and precise AI assistant.

# MEMORY
- You have access to past conversations via semantic memory.
- Relevant past messages may be injected into the context.
- Use them naturally when answering.
- Never state that you do not have access to previous chats.

# DOCUMENTS (RAG)
- You may receive snippets from uploaded documents (PDFs, files, images).
- When document snippets are provided and relevant, treat them as the primary source of truth.
- If you answer based on documents, explicitly say:
  "According to the uploaded document, ..."

# VALIDATION MODE
- When the user asks for validation (e.g., code, SQL, logic, configuration):
  - Do NOT explain unless explicitly asked.
  - Respond only with VALID or INVALID.
  - If INVALID, provide only the corrected final answer (e.g., corrected code or query).
  - Do not include reasoning, steps, or summaries.

# CODING MODE
- When the user asks for code (e.g., “give example”, “write code”, “create a button in HTML”):
  - Respond primarily with code blocks.
  - Keep explanations minimal (one short line if needed), or omit them unless explicitly requested.
  - For simple tasks (e.g., “create an HTML button”), return just the code needed to solve the task.
- When the user asks to fix or improve code:
  - Return the corrected code in a single code block.
  - Do not include long explanations unless explicitly requested.

# TOOLS
- Weather tool → weather-related questions only.
- Calculator tool → mathematical calculations only.
- Location tool → user location-related questions only.
- Use tools only when clearly necessary.

# GENERAL BEHAVIOR
- Be concise, accurate, and direct.
- Do not add unnecessary explanations.
- Avoid assumptions when information is insufficient.
- If asked about past chats, summarize using injected context only.


`,
});

// ---------- SERVER ----------
const USER_ID = "mohammed-alith" as const;

// Match the frontend type shape
interface UIMessage {
  role: "user" | "assistant" | "system" | "function" | "tool";
  content: string;
}

async function bootstrap() {
  // Ensure pgvector + documents table exist
  await initDocumentVectorTable();

  new VoltAgent({
    agents: {
      "sample-app": agent,
    },
    server: honoServer({
      configureApp: (app) => {
        // 1) List conversations (history UI)
        app.get("/api/conversations", async (c) => {
          const conversations = await memory.getConversationsByUserId(
            USER_ID,
            {
              limit: 50,
              orderBy: "created_at",
              orderDirection: "DESC",
            }
          );

          return c.json({ conversations });
        });

        // 2) Get messages for a conversation
        app.get("/api/history", async (c) => {
          const conversationId = c.req.query("conversationId");
          if (!conversationId) {
            return c.json({ error: "conversationId is required" }, 400);
          }

          const messages = await memory.getMessages(
            USER_ID,
            conversationId,
            {
              limit: 50,
             
            }
          );

          return c.json({
            userId: USER_ID,
            conversationId,
            messages,
          });
        });

        // 3) Ingest document text into `documents` table + mark in history
        app.post("/api/documents/ingest", async (c) => {
          const body = await c.req.json();
          const text = String(body.text ?? "");
          const conversationId = body.conversationId ?? null;

          const trimmed = text.trim();
          if (!trimmed) {
            return c.json({ error: "text is required" }, 400);
          }

          // Store in documents vector store (chunked inside ingestDocumentText)
          await ingestDocumentText(trimmed);

          // Also record an event in conversation history
          if (conversationId) {
            const preview =
              trimmed.slice(0, 300) +
              (trimmed.length > 300 ? "..." : "");

            const message: UIMessage = {
              role: "system",
              content:
                "[Document ingested into knowledge base as chunks]\n" +
                preview,
            };

            await memory.addMessage(message as any, USER_ID, conversationId);
          }

          return c.json({ success: true });
        });

        // 4) Normal chat with RAG over documents
        app.post("/api/chat", async (c) => {
          const body = await c.req.json();
          const text = String(body.text ?? "");
          const conversationId =
            body.conversationId ?? `conv_${Date.now()}`;

          if (!text.trim()) {
            return c.json({ error: "text is required" }, 400);
          }

          // --- RAG: retrieve document snippets ---
          let ragContext = "";
          try {
            const docs = await searchDocumentsByQuery(text, 5);
            if (docs && docs.length > 0) {
              const snippets = docs
                .map(
                  (d, idx) =>
                    `Snippet ${idx + 1}:\n${d.content.slice(0, 1000)}`
                )
                .join("\n\n---\n\n");

              ragContext = snippets.slice(0, 4000);
            }
          } catch (e) {
            console.error("[backend] RAG search error (ignored):", e);
          }

          const messages: BaseMessage[] = [];

          if (ragContext) {
            messages.push({
              role: "system",
              content:
                "The following snippets are from the user's uploaded documents. Use them if relevant:\n\n" +
                ragContext,
            });
          }

          messages.push({
            role: "user",
            content: text,
          });

          const result = await agent.generateText(messages, {
            userId: USER_ID,
            conversationId,
            semanticMemory: {
              enabled: true,
              semanticLimit: 10,
              semanticThreshold: 0.6,
            },
          });

          return c.json({
            text: result.text,
            conversationId,
          });
        });

        // 5) Multimodal / file + question chat (vector chat)
        //    → THIS is what your frontend calls /api/mm-chat
        app.post("/api/mm-chat", async (c) => {
          const form = await c.req.parseBody();
          const file = form["file"] as File | undefined;
          const question = (form["question"] as string) || "";
          const existingConversationId = form["conversationId"] as
            | string
            | undefined;

          const conversationId =
            existingConversationId || `conv_${Date.now()}`;

          let uploadedText = "";

          // Extract text from uploaded file (simple implementation: treat as text)
          if (file) {
            // For PDFs, you can replace this with pdf-parse logic.
            uploadedText = await file.text();
          }

          // If we have file text, ingest it into the vector store
          if (uploadedText.trim()) {
            await ingestDocumentText(uploadedText);

            // Optional: add a system marker into conversation history
            const preview =
              uploadedText.slice(0, 300) +
              (uploadedText.length > 300 ? "..." : "");

            const ingestMsg: UIMessage = {
              role: "system",
              content:
                "[Document ingested into knowledge base as chunks]\n" +
                preview,
            };

            await memory.addMessage(
              ingestMsg as any,
              USER_ID,
              conversationId
            );
          }

          const effectiveQuestion =
            question.trim() ||
            (uploadedText
              ? "Summarize the uploaded document."
              : "Explain the uploaded content.");

          // --- RAG over documents using the question ---
          let ragContext = "";
          try {
            const docs = await searchDocumentsByQuery(effectiveQuestion, 5);
            if (docs && docs.length > 0) {
              const snippets = docs
                .map(
                  (d, idx) =>
                    `Snippet ${idx + 1}:\n${d.content.slice(0, 1000)}`
                )
                .join("\n\n---\n\n");

              ragContext = snippets.slice(0, 4000);
            }
          } catch (e) {
            console.error("[backend] RAG search error (ignored):", e);
          }

          const messages: BaseMessage[] = [];

          if (ragContext) {
            messages.push({
              role: "system",
              content:
                "The following snippets are from the user's uploaded documents. Use them if relevant:\n\n" +
                ragContext,
            });
          }

          // User question message
          messages.push({
            role: "user",
            content: effectiveQuestion,
          });

          // IMPORTANT:
          // Use agent.generateText so BOTH user + assistant messages
          // are automatically written into Voltagent memory.
          const result = await agent.generateText(messages, {
            userId: USER_ID,
            conversationId,
            semanticMemory: {
              enabled: true,
              semanticLimit: 10,
              semanticThreshold: 0.6,
            },
          });

          const answer = result.text ?? "(no answer)";

          return c.json({
            answer,
            conversationId,
          });
        });
      },
    }),
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start Voltagent backend:", err);
  process.exit(1);
});
