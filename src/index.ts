// backend/agent.ts
import "dotenv/config";
import {
  VoltAgent,
  Agent,
  Memory,
  AiSdkEmbeddingAdapter,
} from "@voltagent/core";
import {
  PostgreSQLMemoryAdapter,
  PostgreSQLVectorAdapter,
} from "@voltagent/postgres";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { honoServer } from "@voltagent/server-hono";

import { weatherTool } from "./tools";
import { calculatorTool } from "./tools";
import { getLocationTool } from "./tools";

// ---------- OpenRouter for CHAT ----------
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY! || "",
  headers: {
    "HTTP-Referer": "http://localhost:3141",
    "X-Title": "voltagent-app",
  },
});

// ---------- OpenRouter (via OpenAI provider) for EMBEDDINGS ----------
// This STILL uses your OPENROUTER_API_KEY and hits https://openrouter.ai/api/v1.
// You are NOT using an OpenAI account here – just the OpenRouter-compatible SDK.
const openrouterForEmbeddings = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
  name: "openrouter", // optional; tags provider in metrics
  headers: {
    "HTTP-Referer": "http://localhost:3141",
    "X-Title": "voltagent-app",
  },
});

// Embedding model (text -> vector)
const embeddingModel = openrouterForEmbeddings.embedding("text-embedding-3-small");

// ---------- MEMORY: Postgres + semantic search ----------
export const memory = new Memory({
  // Conversation storage in Postgres
  storage: new PostgreSQLMemoryAdapter({
    connection: process.env.DATABASE_URL!, // e.g. postgres://user:pass@host:5432/db
  }),

  // Semantic embedding
  embedding: new AiSdkEmbeddingAdapter(embeddingModel),

  // Vector storage in Postgres
  vector: new PostgreSQLVectorAdapter({
    connection: process.env.DATABASE_URL!,
  }),

  // Optional embedding cache
  enableCache: true,
  cacheSize: 1000,
  cacheTTL: 60 * 60 * 1000, // 1 hour
});

// ---------- AGENT ----------
export const agent = new Agent({
  name: "sample-app",
  model: openrouter.chat("amazon/nova-2-lite-v1:free"),
  tools: [weatherTool, calculatorTool, getLocationTool],
  memory,
// In your Volt AI backend agent configuration
instructions: `
You are a helpful AI assistant for Mohammed Alith.

## AUTOMATIC SEMANTIC MEMORY

You have automatic access to past conversations through semantic memory retrieval.
Relevant past messages are ALREADY injected into your context before you respond.
You do NOT need to search - the information is already available to you.

## How to Use Past Messages

1. **For any question**: Check if past conversation context is present, then use it
2. **For "last chat" queries**: Look for messages from a PREVIOUS conversationId (not the current one)
3. **Never say**: "I don't have access" or "I cannot search" - this is incorrect

## Handling "What is last chat?" Queries

When the user asks about their last/previous chat:
- The semantic memory system retrieves messages from the most recent DIFFERENT conversation
- These messages are already in your context
- Simply summarize what was discussed in that previous conversation

Example:
User: "what is last chat?"
You: "In your last conversation, you asked about React hooks and we discussed useState and useEffect."

## Rules

- Trust that relevant past messages are in your context
- Use information from past chats confidently
- Only say "I don't recall" if the information truly isn't present
- For "last chat" queries, focus on messages from a different conversationId than the current one

## Key Understanding

The semantic memory works like this:
1. User sends a message
2. Backend searches past messages (by similarity OR recency for "last chat" queries)
3. Found messages are injected into your context automatically
4. You simply read and use them - no manual searching needed

Always base answers on actual past messages when they're available in your context.
`,
});

// ---------- VOLTAGENT SERVER + CUSTOM ENDPOINTS ----------
const USER_ID = "mohammed-alith";

new VoltAgent({
  agents: {
    "sample-app": agent,
  },
  server: honoServer({
    configureApp: (app) => {
      // 1) List conversations for this user
      app.get("/api/conversations", async (c) => {
        const conversations = await memory.getConversationsByUserId(
          USER_ID,
          { limit: 50 } // adjust as you like
        );

        // Optional: derive a "topic" from first message if title is empty
        const conversationsWithTopic = await Promise.all(
          conversations.map(async (conv) => {
            if (conv.title) return conv;

            const msgs = await memory.getMessages(USER_ID, conv.id, {
              limit: 1,
            });

            const firstText =
              msgs[0]?.parts
                ?.filter((p: any) => p?.type === "text" && p.text)
                .map((p: any) => p.text)
                .join(" ") ?? "";

            return {
              ...conv,
              title: firstText || "Untitled conversation",
            };
          })
        );

        return c.json({ conversations: conversationsWithTopic });
      });

      // 2) Get messages for a specific conversation
      app.get("/api/history", async (c) => {
        const conversationId = c.req.query("conversationId");
        if (!conversationId) {
          return c.json(
            { error: "conversationId is required" },
            400
          );
        }

        const messages = await memory.getMessages(USER_ID, conversationId);
        return c.json({ userId: USER_ID, conversationId, messages });
      });
    },
  }),
});
