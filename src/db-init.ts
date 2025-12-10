// backend/db-init.ts
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Initializes pgvector + `documents` table.
 * Safe to call multiple times.
 */
export async function initDocumentVectorTable() {
  const client = await pool.connect();

  try {
    // Enable pgvector extension
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
    `);

    // Documents table (now chunk-aware)
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        embedding VECTOR(1536) NOT NULL,
        chunk_index INT
      );
    `);

    // Backward-safe: ensure column exists even if table was old
    await client.query(`
      ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS chunk_index INT;
    `);

    // Vector index
    await client.query(`
      CREATE INDEX IF NOT EXISTS embeddingIndex
      ON documents USING hnsw (embedding vector_cosine_ops);
    `);

    console.log("[DB] documents vector table ready (chunk-enabled)");
  } finally {
    client.release();
  }
}
