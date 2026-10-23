import { defineApp } from "convex/server";
import { v } from "convex/values";
import daytona from "@daytona/convex/convex.config.js";

const app = defineApp({
  env: {
    DAYTONA_API_KEY: v.string(),
    // Optional: enables webhook-driven sandbox state sync (see README).
    DAYTONA_WEBHOOK_SECRET: v.optional(v.string()),
  },
});

// Components can't read the app's env vars, so pass them down. Passing them
// by reference means the component always sees the current values.
app.use(daytona, {
  // Mounts the component's webhook route at /daytona/webhook.
  httpPrefix: "/daytona/",
  env: {
    DAYTONA_API_KEY: app.env.DAYTONA_API_KEY,
    DAYTONA_WEBHOOK_SECRET: app.env.DAYTONA_WEBHOOK_SECRET,
  },
});

export default app;
