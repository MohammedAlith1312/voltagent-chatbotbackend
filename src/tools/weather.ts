import { createTool } from "@voltagent/core";
import { z } from "zod";

export const weatherTool = createTool({
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: z.object({
    location: z.string().describe("The city name"),
  }),
  execute: async ({ location }) => {
    // Call weather API
    const response = await fetch(
        `http://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${location}`
      );
    const data = await response.json();

    return {
      location: data.location.name,
      temperature: `${data.current.temp_c}°C`,
      condition: data.current.condition.text,
      humidity: `${data.current.humidity}%`,
      wind: `${data.current.wind_kph} kph`,
    };
  },
});