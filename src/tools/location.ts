import { createTool } from "@voltagent/core";
import { z } from "zod";
export const getLocationTool = createTool({
  name: "getLocation",
  description: "Get the user's current location",
  parameters: z.object({}),
  // No execute = client-side
});