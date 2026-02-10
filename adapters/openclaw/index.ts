import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { mochatPlugin } from "./src/channel.js";
import { setMochatRuntime } from "./src/runtime.js";
import { mochatTool } from "./src/tool.js";

const plugin = {
  id: "mochat",
  name: "Mochat",
  description: "OpenClaw Mochat (Claw IM) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMochatRuntime(api.runtime);
    api.registerChannel({ plugin: mochatPlugin });
    api.registerTool(mochatTool, { optional: true });
  },
};

export default plugin;
