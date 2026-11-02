import { Daytona } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk/v2";
import type { AgentResult } from "@inngest/agent-kit";

type SandboxNetwork = {
  readonly state: { readonly data: { sandbox?: Sandbox } };
};

export function extractTextMessageContent(
  result: AgentResult | undefined
): string {
  const textMessage = result?.output.find(
    (msg) => msg.type === "text"
  );
  if (!textMessage || !textMessage.content) return "";
  if (typeof textMessage.content === "string") return textMessage.content;
  if (Array.isArray(textMessage.content)) {
    return textMessage.content.map((c) => c.text).join("");
  }
  return "";
}

export async function createSandbox(network?: SandboxNetwork, client?: Daytona) {
  const image = process.env.DAYTONA_V2_IMAGE?.trim();
  if (!image) throw new TypeError("DAYTONA_V2_IMAGE must name a registered Daytona v2 image");
  const daytona = client ?? new Daytona({ requestTimeout: 30000, otelEnabled: false });
  const sandbox = await daytona.v2.create(image, {
      labels: { "sdk2-readiness": "inngest-agentkit-coding-agent" },
      lifecyclePolicy: { timeoutSeconds: 1200, onTimeout: "delete" },
      waitSeconds: 90,
      createTimeoutSeconds: 90,
  });
  if (network) network.state.data.sandbox = sandbox;
  return sandbox;
}

export async function getSandbox(network?: SandboxNetwork) {
  return network?.state.data.sandbox ?? createSandbox(network);
}

export async function getPreviewLink(sandbox: Sandbox, port: number) {
  return sandbox.ports.previewLink(port);
}

export const logDebug = (message: string) => {
  const enableDebugLogs = process.env.ENABLE_DEBUG_LOGS === "true";
  if (enableDebugLogs) console.log(message);
};
