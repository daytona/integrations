import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("daytona", {
  // Passed down by the app in its convex.config.ts (see README). Optional so
  // existing installs keep deploying, but runBackground needs it: its poller
  // runs from the scheduler, outside any call from the app.
  env: {
    DAYTONA_API_KEY: v.optional(v.string()),
    // Signing secret of the Daytona webhook endpoint (see README). Optional:
    // webhook-driven state sync is opt-in, and the webhook route refuses every
    // request when it isn't set.
    DAYTONA_WEBHOOK_SECRET: v.optional(v.string()),
  },
});
