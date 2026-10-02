import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("daytona", {
  // Passed down by the app in its convex.config.ts (see README). Optional so
  // existing installs keep deploying, but runBackground needs the key: its
  // poller runs from the scheduler, outside any call from the app.
  env: {
    DAYTONA_API_KEY: v.optional(v.string()),
    DAYTONA_API_URL: v.optional(v.string()),
  },
});
