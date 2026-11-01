import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * Sealed keys for an installing app. `CONNECTION_KEY` is optional so a push succeeds before the deployment has
 * one; sealing fails closed until it is set. The app forwards its own `CONNECTION_KEY`.
 */
export default defineComponent("accountKeys", {
  env: {
    CONNECTION_KEY: v.optional(v.string()),
  },
});
