// backend/vector-store.ts
import { Pool } from "pg";
import OpenAI from "openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// Use same DB as Voltagent memory
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ✅ Use OpenRouter via OpenAI client (NOT OPENAI_API_KEY)
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY!, // required
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "http://localhost:3141", // or your backend URL
    "X-Title": "voltagent-app",
  },
});

// ---------- Text splitter (chunking) ----------
const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 150,
  chunkOverlap: 20,
  separators: ["\n\n", "\n", " ", ""], // keeps structure better than just [" "]
});

async function splitIntoChunks(text: string): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return textSplitter.splitText(trimmed);
}

// ---------- Embeddings helper ----------
async function getEmbedding(text: string): Promise<number[]> {
  const input = text.trim();
  if (!input) {
    throw new Error("Cannot create embedding for empty text");
  }

  const res = await openai.embeddings.create({
    model: "text-embedding-3-small", // 1536 dimensions
    input,
  });

  const emb = res.data[0]?.embedding;
  if (!emb || emb.length === 0) {
    throw new Error("OpenRouter (OpenAI client) returned empty embedding");
  }

  return emb;
}

/**
 * Insert text into the `documents` table as CHUNKS + embeddings.
 *
 * Expected table (simplified):
 *
 *   CREATE TABLE documents (
 *     id SERIAL PRIMARY KEY,
 *     content TEXT NOT NULL,
 *     embedding VECTOR(1536) NOT NULL,
 *     chunk_index INT
 *   );
 */
export async function ingestDocumentText(text: string) {
  const chunks = await splitIntoChunks(text);
  if (!chunks.length) return;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = await getEmbedding(chunk);
    const embeddingLiteral = `[${embedding.join(",")}]`; // pgvector literal

    await pool.query(
      `
        INSERT INTO documents (content, embedding, chunk_index)
        VALUES ($1, $2::vector, $3)
      `,
      [chunk, embeddingLiteral, i]
    );
  }
}

/**
 * Retrieve similar document CHUNKS from `documents` for a given query.
 */
export async function searchDocumentsByQuery(query: string, limit = 5) {
  const q = query.trim();
  if (!q) return [];

  const embedding = await getEmbedding(q);
  const embeddingLiteral = `[${embedding.join(",")}]`;

  type Row = {
    id: number;
    content: string;
    // optional: chunk_index?: number;
  };

  const res = await pool.query<Row>(
    `
     SELECT
  id,
  content,
  1 - (embedding <=> $1::vector) AS similarity
FROM documents
WHERE document_id = $2
ORDER BY similarity DESC
LIMIT $3;
;
    `,
    [embeddingLiteral, limit]
  );

  return res.rows;
}

// Optional: helper to close pool on shutdown (if you need it)
export async function closeVectorStore() {
  await pool.end();
}
