import path from "node:path";
import { pathToFileURL } from "node:url";

import { createAgentEndHandler } from "../../gazza-callback.js";

// agent_end sees the embedded runner's run id. The HTTP /hooks/agent run id
// is different, so this plugin only reports the reply. The wrapper pairs it
// with the run id it already returned to Gazza.
const spec = {
  id: "gazza-callback",
  name: "Gazza callback",
  description: "Forwards finished Gazza hook runs to the Railway wrapper.",
  register(api) {
    api.on("agent_end", createAgentEndHandler({
      prefix: process.env.OPENCLAW_HOOKS_SESSION_PREFIX,
      bridgeUrl: process.env.OPENCLAW_GAZZA_BRIDGE_URL,
      bridgeToken: process.env.OPENCLAW_GAZZA_BRIDGE_TOKEN,
    }));
  },
};

async function publish(entry) {
  const openclawEntry = process.env.OPENCLAW_ENTRY;
  if (openclawEntry) {
    try {
      const sdk = pathToFileURL(path.join(path.dirname(openclawEntry), "plugin-sdk/plugin-entry.js")).href;
      const mod = await import(sdk);
      if (typeof mod.definePluginEntry === "function") return mod.definePluginEntry(entry);
    } catch {
      // The plain entry object is the documented register() shape.
    }
  }
  try {
    const mod = await import("openclaw/plugin-sdk/plugin-entry");
    if (typeof mod.definePluginEntry === "function") return mod.definePluginEntry(entry);
  } catch {
    // Same fallback when the SDK package is not resolvable from this directory.
  }
  return entry;
}

export default await publish(spec);
