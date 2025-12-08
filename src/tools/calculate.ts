import { createTool } from "@voltagent/core";
import { z } from "zod";

export const calculatorTool = createTool({
  name: "calculate",
  description: "Perform mathematical calculations",
  parameters: z.object({
    expression: z.string().describe("The mathematical expression to evaluate"),
  }),
  execute: async ({ expression }) => {
    // Use a safe math parser in production
    const result = eval(expression);
    return { result };
  },
});