/** TrueForge SDK client factory. In local standalone mode no token is needed. */
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { getSettings } from "../config/settings.ts";

export function makeTrueForgeClient(baseUrlOverride?: string): TrueForge {
  const s = getSettings();
  const baseUrl = baseUrlOverride ?? s.TRUEFORGE_BASE_URL ?? `http://localhost:${s.TRUEFORGE_PORT}`;
  return new TrueForge({ baseUrl, timeoutInSeconds: 600 });
}
