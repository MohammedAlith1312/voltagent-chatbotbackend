// backend/text-splitter.ts
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 150,
  chunkOverlap: 20,
  separators: ["\n\n", "\n", " ", ""], // keeps structure better than just [" "]
});

export async function chunkContent(content: string) {
  return textSplitter.splitText(content.trim());
}
