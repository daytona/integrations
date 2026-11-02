import { Daytona } from "@daytona/sdk";
import type { CreateSandboxOptions, Sandbox } from "@daytona/sdk/v2";
import { AgentResult, NetworkRun } from "@inngest/agent-kit";
import type { TextMessage } from "@inngest/agent-kit";

export function extractTextMessageContent(
  result: AgentResult | undefined
): string {
  const textMessage = result?.output.find(
    (msg) => msg.type === "text"
  ) as TextMessage;
  if (!textMessage || !textMessage.content) return "";
  if (typeof textMessage.content === "string") return textMessage.content;
  if (Array.isArray(textMessage.content)) {
    return textMessage.content.map((c) => c.text).join("");
  }
  return "";
}

export async function createSandbox(
  network?: NetworkRun<Record<string, any>>,
  extras: Pick<CreateSandboxOptions, "labels" | "lifecyclePolicy"> & {
    client?: Daytona;
  } = {}
) {
  // v2 has no platform default image in the measured environment.
  const image = process.env.DAYTONA_V2_IMAGE?.trim();
  if (!image)
    throw new TypeError(
      "DAYTONA_V2_IMAGE must name a registered Daytona v2 image"
    );
  const { client, ...options } = extras;
  const daytona = client ?? new Daytona();
  let sandbox: Sandbox;
  try {
    sandbox = await daytona.v2.create(image, {
      ...options,
      waitSeconds: 90,
      createTimeoutSeconds: 90,
    });
  } catch (error) {
    throw new Error(`Failed to create Daytona sandbox: ${error}`, {
      cause: error,
    });
  }
  if (network) network.state.data.sandbox = sandbox;
  return sandbox;
}

export async function getSandbox(network?: NetworkRun<Record<string, any>>) {
  let sandbox = network?.state.data.sandbox as Sandbox;
  if (!sandbox) sandbox = await createSandbox(network);
  return sandbox;
}

export const logDebug = (message: string) => {
  const enableDebugLogs = process.env.ENABLE_DEBUG_LOGS === "true";
  if (enableDebugLogs) console.log(message);
};
