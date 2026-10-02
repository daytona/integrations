import { defineApp } from "convex/server";
import { v } from "convex/values";
import daytona from "@daytona/convex/convex.config.js";

const app = defineApp({
  env: {
    DAYTONA_API_KEY: v.string(),
    // Only needed for self-hosted Daytona; defaults to Daytona Cloud.
    DAYTONA_API_URL: v.optional(v.string()),
  },
});

// Components can't read the app's env vars, so pass them down. Passing them
// by reference means the component always sees the current value.
app.use(daytona, {
  env: {
    DAYTONA_API_KEY: app.env.DAYTONA_API_KEY,
    DAYTONA_API_URL: app.env.DAYTONA_API_URL,
  },
});

export default app;
