import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { SoftwarePasskey } from "./softwareAuthenticator";

/** Creates an account with `passkey` the way the jive.sh page does, and returns its first session. */
export async function registerAccount(client: ConvexHttpClient, passkey: SoftwarePasskey, signInRequestId?: string) {
  const { options } = await client.action(api.auth.registrationOptions, {});
  const response = await passkey.register(options);
  return await client.action(api.auth.register, { challenge: options.challenge, response, ...(signInRequestId === undefined ? {} : { signInRequestId }) });
}
