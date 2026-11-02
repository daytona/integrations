import "dotenv/config";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createAgent, createNetwork, createTool, anthropic } from "@inngest/agent-kit";
import { DaytonaError } from "@daytona/sdk";
import { getSandbox, getPreviewLink, extractTextMessageContent, logDebug } from "./utils.js";
import { uploadFilesTool, readFileTool, deleteFileTool, createDirectoryTool, deleteDirectoryTool } from "./file-tools.js";

export const codeRunTool = createTool({
  name: "codeRunTool",
  description: `Executes Python code in the Daytona v2 sandbox.
Parameters: code is the code to execute; env contains environment variables.
argv is retained for compatibility but is not supported on Daytona v2; use shellTool for command-line arguments.`,
  parameters: z.object({
    code: z.string(),
    argv: z.array(z.string()).nullable(),
    env: z.record(z.string(), z.string()).nullable(),
  }),
  handler: async ({ code, argv, env }, { network }) => {
    if (argv !== null) return "argv is not supported on Daytona v2 (not supported on v2); use shellTool instead";
    try {
      const sandbox = await getSandbox(network);
      const response = await sandbox.runCode(code, {
        language: "python", isolated: true, env: env ?? {}, timeout: 45000,
      });
      if (response.error) return `Code execution error: ${response.error.name}: ${response.error.value}\n${response.error.traceback.join("\n")}`;
      const message = `Code run result: ${response.logs.stdout}\nStderr: ${response.logs.stderr}\nReason: ${response.process.reason}`;
      logDebug(message);
      return message;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error executing code:", error);
      if (error instanceof DaytonaError) return `Code execution Daytona error: ${error.message}`;
      return "Error executing code";
    }
  },
});

export const shellTool = createTool({
  name: "shellTool",
  description: `Executes a shell command inside the sandbox. Use for installing packages, running scripts, or manipulating files. Never start a development server here; use startDevServerTool.
Parameters: shellCommand is the command, env contains environment variables.`,
  parameters: z.object({ shellCommand: z.string(), env: z.record(z.string(), z.string()).nullable() }),
  handler: async ({ shellCommand, env }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      const response = await sandbox.exec(shellCommand, {
        env: env ?? {}, timeout: 45000, executionTimeout: 45000,
      });
      const message = `Command result: ${response.output}\nStdout: ${response.stdout}\nStderr: ${response.stderr}\nReason: ${response.reason}\nExit code: ${response.exitCode ?? "none"}`;
      logDebug(message);
      return message;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error executing shell command:", error);
      if (error instanceof DaytonaError) return `Shell command execution Daytona error: ${error.message}`;
      return "Error executing shell command";
    }
  },
});

export const startDevServerTool = createTool({
  name: "startDevServerTool",
  description: "Starts a development server in the sandbox without waiting for it to exit. Supply the shell command in startCommand.",
  parameters: z.object({ startCommand: z.string() }),
  handler: async ({ startCommand }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      const savedId = network.state.data.devServerSessionId;
      const session = savedId
        ? sandbox.process.connectSession(savedId)
        : await sandbox.process.createSession({ name: "start-dev-server-cmd" });
      network.state.data.devServerSessionId = session.id;
      const handle = await session.start(startCommand, { executionTimeout: 600000 });
      network.state.data.devServerSessionCommandId = handle.id;
      return `Successfully queued dev server with command: ${startCommand}; check its health before reporting readiness`;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error starting dev server:", error);
      if (error instanceof DaytonaError) return `Dev server start Daytona error: ${error.message}`;
      return "Error starting dev server";
    }
  },
});

export const checkDevServerHealthTool = createTool({
  name: "checkDevServerHealthTool",
  description: "Reads stdout and stderr logs for the last development server command. Logs alone do not prove HTTP readiness.",
  parameters: z.object({}),
  handler: async ({}, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      const commandId = network.state.data.devServerSessionCommandId;
      if (!commandId) return "No development server command has been started";
      const handle = sandbox.process.connect(commandId);
      const page = await handle.logs({ limit: 1000 });
      let stdout = "", stderr = "";
      for (const frame of page.items) {
          const data = frame.encoding === "base64" ? Buffer.from(frame.data, "base64").toString("utf8") : frame.data;
          // LogFrame.channel is an open string, not a closed tagged union.
          if (frame.channel === "stdout") stdout += data;
          else if (frame.channel === "stderr") stderr += data;
      }
      const message = `Dev server health check result (up to 1000 log frames):\nStdout: ${stdout}\nStderr: ${stderr}`;
      logDebug(message);
      return message;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error checking dev server health:", error);
      if (error instanceof DaytonaError) return `Dev server health check Daytona error: ${error.message}`;
      return "Error checking dev server health";
    }
  },
});

async function main() {
  const codingAgent = createAgent({
    name: "Coding Agent",
    description: "An autonomous coding agent for building software in a Daytona sandbox",
    system: `You are a coding agent designed to help the user achieve software development tasks. You have access to a Daytona sandbox environment.

Capabilities:
- You can execute Python code snippets or scripts.
- You can run shell commands to install dependencies, manipulate files, and set up environments.
- You can create, upload, and organize files and directories to build basic applications and project structures.

Workspace Instructions:
- The default workspace directory is /root (the measured home and working directory, running as root).
- All file and folder operations (create, upload, organize) should use paths relative to this default workspace.
- Do not attempt to create or configure the workspace itself; focus only on the requested development tasks.

Guidelines:
- Always analyze the user's request and plan your steps before taking action.
- Prefer automation and scripting over manual or interactive steps.
- When installing packages or running commands that may prompt for input, use flags (e.g., '-y') to avoid blocking.
- If you are developing an app that is served with a development server (e.g. Next.js, React):
  1. Return the port information in the form: DEV_SERVER_PORT=$PORT (replace $PORT with the actual port number).
  2. Start the development server.
  3. After starting the dev server, always check its health in the next iteration. Only mark the task as complete if the health check passes: there must be no stderr output, no errors thrown, and the stdout content must not indicate a problem (such as error messages, stack traces, or failed startup). If any of these are present, diagnose and fix the issue before completing the task.
- When you have completed the requested task, set the "TASK_COMPLETED" string in your output to signal that the app is finished.
`,
    model: anthropic({ model: "claude-3-5-haiku-20241022", defaultParameters: { max_tokens: 1024 } }),
    tools: [shellTool, codeRunTool, uploadFilesTool, readFileTool, deleteFileTool, createDirectoryTool, deleteDirectoryTool, startDevServerTool, checkDevServerHealthTool],
  });

  const network = createNetwork({
    name: "coding-agent-network",
    agents: [codingAgent],
    maxIter: 30,
    defaultRouter: ({ network, callCount }) => {
      const previousIterationMessageContent = extractTextMessageContent(network.state.results.at(-1));
      if (previousIterationMessageContent) logDebug(`Iteration message:\n${previousIterationMessageContent}\n`);
      console.log(`\n ===== Iteration #${callCount + 1} =====\n`);
      if (callCount > 0 && previousIterationMessageContent.includes("TASK_COMPLETED")) {
        const isDevServerAppMessage = network.state.results
          .map((result) => extractTextMessageContent(result))
          .findLast((messageContent) => messageContent.includes("DEV_SERVER_PORT"));
        if (isDevServerAppMessage) {
          const portMatch = isDevServerAppMessage.match(/DEV_SERVER_PORT=([0-9]+)/);
          const port = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : undefined;
          if (port) network.state.data.devServerPort = port;
        }
        return;
      }
      return codingAgent;
    },
  });

  const result = await network.run(
    `Create a minimal React app called "Notes" that lets users add, view, and delete notes. Each note should have a title and content. Use Create React App or Vite for setup. Include a simple UI with a form to add notes and a list to display them.`
  );
  try {
    const sandbox = await getSandbox(result);
    const devServerPort = result.state.data.devServerPort;
    if (devServerPort) {
      const previewInfo = await getPreviewLink(sandbox, devServerPort);
      console.log("\x1b[32m✔ App is ready!\x1b[0m\n\x1b[36mPreview: " + previewInfo.url + "\x1b[0m");
      if (previewInfo.token) console.log("Private preview: send the X-Daytona-Preview-Token header using the token from ports.previewLink; the token is not logged.");
    } else await sandbox.delete();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error("An error occurred during the final phase:", error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
