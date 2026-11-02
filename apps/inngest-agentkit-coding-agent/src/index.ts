import "dotenv/config";

import { z } from "zod";
import {
  createAgent,
  createNetwork,
  createTool,
  anthropic,
} from "@inngest/agent-kit";
import { DaytonaError } from "@daytona/sdk";
import { getSandbox, extractTextMessageContent, logDebug } from "./utils.js";
import { Buffer } from "buffer";

async function main() {
  const codeRunTool = createTool({
    name: "codeRunTool",
    description: `Executes code in the Daytona sandbox. Use this tool to run code snippets, scripts, or application entry points.
Parameters:
    - code: Code to execute.
    - argv: Not supported on Daytona v2; leave it null or empty (use shellTool to pass command line arguments).
    - env: Environment variables for the code execution, as key-value pairs.`,
    parameters: z.object({
      code: z.string(),
      argv: z.array(z.string()).nullable(),
      env: z.record(z.string(), z.string()).nullable(),
    }),
    handler: async ({ code, argv, env }, { network }) => {
      if (argv?.length)
        return "argv is not supported on Daytona v2 (not supported on v2); use shellTool instead";
      try {
        const sandbox = await getSandbox(network);
        const codeRunParams = {
          language: "python",
          isolated: true,
          env: env ?? {},
        } as const;
        console.log(`[TOOL: codeRunTool]\nParams: ${codeRunParams}\n${code}`);
        const response = await sandbox.runCode(code, codeRunParams);
        const responseMessage = response.error
          ? `Code execution error: ${response.error.name}: ${response.error.value}\n${response.error.traceback.join("\n")}`
          : `Code run result: ${response.logs.stdout}\nStderr: ${response.logs.stderr}\nReason: ${response.process.reason}`;
        logDebug(responseMessage);
        return responseMessage;
      } catch (error) {
        console.error("Error executing code:", error);
        if (error instanceof DaytonaError)
          return `Code execution Daytona error: ${error.message}`;
        else return "Error executing code";
      }
    },
  });

  const shellTool = createTool({
    name: "shellTool",
    description: `Executes a shell command inside the Daytona sandbox environment. Use this tool for tasks like installing packages, running scripts, or manipulating files via shell commands. Never use this tool to start a development server; always use startDevServerTool for this purpose.
Parameters:
    - shellCommand: Shell command to execute (e.g., "npm install", "ls -la").
    - env: Environment variables to set for the command as key-value pairs (e.g. { "NODE_ENV": "production" }).`,
    parameters: z.object({
      shellCommand: z.string(),
      env: z.record(z.string(), z.string()).nullable(),
    }),
    handler: async ({ shellCommand, env }, { network }) => {
      try {
        const sandbox = await getSandbox(network);
        console.log(
          `[TOOL: shellTool]\nCommand: ${shellCommand}\nEnv: ${JSON.stringify(
            env
          )}`
        );
        const response = await sandbox.exec(shellCommand, { env: env ?? {} });
        const responseMessage = `Command result: ${response.output}\nStdout: ${response.stdout}\nStderr: ${response.stderr}\nReason: ${response.reason}\nExit code: ${response.exitCode ?? "none"}`;
        logDebug(responseMessage);
        return responseMessage;
      } catch (error) {
        console.error("Error executing shell command:", error);
        if (error instanceof DaytonaError)
          return `Shell command execution Daytona error: ${error.message}`;
        else return "Error executing shell command";
      }
    },
  });

  const uploadFilesTool = createTool({
    name: "uploadFilesTool",
    description: `Uploads one or more files to the Daytona sandbox. Use this tool to transfer source code, configuration files, or other assets required for execution or setup. If a file already exists at the specified path, its contents will be replaced with the new content provided. To update a file, simply upload it again with the desired content.
Parameters:
  - files: Array of files to upload. Each file object must have:
    - path (string): The destination file path in the sandbox.
    - content (string): The full contents of the file as a string.
    Example: files: [{ path: "src/index.ts", content: "console.log('Hello world');" }]
Note: Always use double quotes (") for the outer 'content' string property. When writing JavaScript or TypeScript file content, use single quotes (') for string literals inside the file. For JSON files, always convert the object to a string before passing as 'content'.`,
    parameters: z.object({
      files: z.array(
        z.object({
          path: z.string(),
          content: z.string(),
        })
      ),
    }),
    handler: async ({ files }, { network }) => {
      try {
        // Handle case when model hallucinates and passes files as string instead of specificed array format
        if (typeof files === "string") {
          try {
            files = JSON.parse(files);
          } catch (e) {
            throw new TypeError(
              "Parameter 'files' must be an array, not a string. If you are passing a string, it must be valid JSON representing an array."
            );
          }
        }
        files = files.map((file) => ({
          ...file,
          content:
            // Handle case when model hallucinates and passes JSON files content as object instead of string
            typeof file.content === "string"
              ? file.content
              : JSON.stringify(file.content, null, 2),
        }));
        const sandbox = await getSandbox(network);
        console.log(`[TOOL: uploadFilesTool]`);
        logDebug(
          `Uploading files: ${files
            .map((f) => "Path: " + f.path + "\nContent: " + f.content)
            .join("\n\n")}`
        );
        const filesToUpload = Object.fromEntries(
          files.map((file) => [file.path, Buffer.from(file.content, "utf-8")])
        );
        const uploadResult = await sandbox.fs.writeMany(filesToUpload);
        if (uploadResult.errors.length)
          return `Files create/upload errors: ${uploadResult.errors.join("; ")}`;
        const uploadFilesMessage = `Successfully created or updated files: ${files
          .map((f) => f.path)
          .join(", ")}`;
        logDebug(uploadFilesMessage);
        return uploadFilesMessage;
      } catch (error) {
        console.error("Error creating/uploading files:", error);
        if (error instanceof DaytonaError)
          return `Files create/upload Daytona error: ${error.message}`;
        else return "Error creating/uploading files";
      }
    },
  });

  const readFileTool = createTool({
    name: "readFileTool",
    description: `Reads the contents of a file from the Daytona sandbox. Use this tool to retrieve source code, configuration files, or other assets for analysis or processing.`,
    parameters: z.object({
      filePath: z.string(),
    }),
    handler: async ({ filePath }, { network }) => {
      try {
        const sandbox = await getSandbox(network);
        console.log(`[TOOL: readFileTool]\nFile path: ${filePath}`);
        const fileBuffer = Buffer.from(await sandbox.fs.read(filePath));
        const fileContent = fileBuffer.toString("utf-8");
        const readFileMessage = `Successfully read file: ${filePath}\nContent:\n${fileContent}`;
        logDebug(readFileMessage);
        return fileContent;
      } catch (error) {
        console.error("Error reading file:", error);
        if (error instanceof DaytonaError)
          return `File reading Daytona error: ${error.message}`;
        else return "Error reading file";
      }
    },
  });

  const deleteFileTool = createTool({
    name: "deleteFileTool",
    description: `Deletes a file from the Daytona sandbox. Use this tool to remove unnecessary or temporary files from the sandbox environment.`,
    parameters: z.object({
      filePath: z.string(),
    }),
    handler: async ({ filePath }, { network }) => {
      try {
        const sandbox = await getSandbox(network);
        console.log(`[TOOL: deleteFileTool]\nFile path: ${filePath}`);
        await sandbox.fs.rm(filePath);
        const deleteFileMessage = `Successfully deleted file: ${filePath}`;
        logDebug(deleteFileMessage);
        return deleteFileMessage;
      } catch (error) {
        console.error("Error deleting file:", error);
        if (error instanceof DaytonaError)
          return `File deletion Daytona error: ${error.message}`;
        else return "Error deleting file";
      }
    },
  });

  const createDirectoryTool = createTool({
    name: "createDirectoryTool",
    description: `Creates a new directory in the Daytona sandbox. Use this tool to prepare folder structures for projects, uploads, or application data.
Parameters:
    - directoryPath: The directory path to create.`,
    parameters: z.object({
      directoryPath: z.string(),
    }),
    handler: async ({ directoryPath }, { network }) => {
      try {
        const sandbox = await getSandbox(network);
        console.log(
          `[TOOL: createDirectoryTool]\nDirectory path: ${directoryPath}`
        );
        await sandbox.fs.mkdir(directoryPath, { mode: "755" });
        const createDirectoryMessage = `Successfully created directory: ${directoryPath}`;
        logDebug(createDirectoryMessage);
        return createDirectoryMessage;
      } catch (error) {
        console.error("Error creating directory:", error);
        if (error instanceof DaytonaError)
          return `Directory creation Daytona error: ${error.message}`;
        else return "Error creating directory";
      }
    },
  });

  const deleteDirectoryTool = createTool({
    name: "deleteDirectoryTool",
    description: `Deletes a directory from the Daytona sandbox. Use this tool to remove unnecessary or temporary directories from the sandbox environment.`,
    parameters: z.object({
      directoryPath: z.string(),
    }),
    handler: async ({ directoryPath }, { network }) => {
      try {
        const sandbox = await getSandbox(network);
        console.log(
          `[TOOL: deleteDirectoryTool]\nDirectory path: ${directoryPath}`
        );
        await sandbox.fs.rm(directoryPath, { recursive: true });
        const deleteDirectoryMessage = `Successfully deleted directory: ${directoryPath}`;
        logDebug(deleteDirectoryMessage);
        return deleteDirectoryMessage;
      } catch (error) {
        console.error("Error deleting directory:", error);
        if (error instanceof DaytonaError)
          return `Directory deletion Daytona error: ${error.message}`;
        else return "Error deleting directory";
      }
    },
  });

  const startDevServerTool = createTool({
    name: "startDevServerTool",
    description: `Starts a development server in the sandbox environment. Use this tool to start any development server (e.g., Next.js, React, etc.). Never use shellTool to start a development server; always use this tool for that purpose.
Parameters:
  - startCommand: The shell command to start the development server (e.g., "npm run dev").`,
    parameters: z.object({
      startCommand: z.string(),
    }),
    handler: async ({ startCommand }, { network }) => {
      try {
        const sandbox = await getSandbox(network);
        console.log(
          `[TOOL: startDevServerTool]\nStart command: ${startCommand}`
        );
        const savedSessionId = network.state.data.devServerSessionId;
        const session = savedSessionId
          ? sandbox.process.connectSession(savedSessionId)
          : await sandbox.process.createSession({ name: "start-dev-server-cmd" });
        network.state.data.devServerSessionId = session.id;
        const sessionExecuteResponse = await session.start(startCommand);
        network.state.data.devServerSessionCommandId =
          sessionExecuteResponse.id;
        const startDevServerMessage = `Successfully started dev server with command: ${startCommand}`;
        logDebug(startDevServerMessage);
        return startDevServerMessage;
      } catch (error) {
        console.error("Error starting dev server:", error);
        if (error instanceof DaytonaError)
          return `Dev server start Daytona error: ${error.message}`;
        else return "Error starting dev server";
      }
    },
  });

  const checkDevServerHealthTool = createTool({
    name: "checkDevServerHealthTool",
    description: `Checks the health of a development server. Use this tool after starting a dev server to verify it is running and accessible.`,
    parameters: z.object({}),
    handler: async ({}, { network }) => {
      try {
        console.log(`[TOOL: checkDevServerHealthTool]`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const sandbox = await getSandbox(network);
        const devServerCommand = sandbox.process.connect(
          network.state.data.devServerSessionCommandId
        );
        const devServerCommandLogs = { stdout: "", stderr: "" };
        // Bounded catch-up: the live log tail keeps returning a cursor, so stop
        // on an empty page, a missing/unchanged cursor, or after 10 pages.
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const logs = await devServerCommand.logs(
            cursor ? { cursor, limit: 1000 } : { limit: 1000 }
          );
          for (const frame of logs.items) {
            const data =
              frame.encoding === "base64"
                ? Buffer.from(frame.data, "base64").toString("utf-8")
                : frame.data;
            if (frame.channel === "stdout") devServerCommandLogs.stdout += data;
            else if (frame.channel === "stderr")
              devServerCommandLogs.stderr += data;
          }
          if (!logs.items.length || !logs.nextCursor || logs.nextCursor === cursor)
            break;
          cursor = logs.nextCursor;
        }
        const healthMessage = `Dev server health check result:\nStdout: ${devServerCommandLogs.stdout}\nStderr: ${devServerCommandLogs.stderr}`;
        logDebug(healthMessage);
        return healthMessage;
      } catch (error) {
        console.error("Error checking dev server health:", error);
        if (error instanceof DaytonaError)
          return `Dev server health check Daytona error: ${error.message}`;
        return `Error checking dev server health`;
      }
    },
  });

  const codingAgent = createAgent({
    name: "Coding Agent",
    description:
      "An autonomous coding agent for building software in a Daytona sandbox",
    system: `You are a coding agent designed to help the user achieve software development tasks. You have access to a Daytona sandbox environment.

Capabilities:
- You can execute code snippets or scripts.
- You can run shell commands to install dependencies, manipulate files, and set up environments.
- You can create, upload, and organize files and directories to build basic applications and project structures.

Workspace Instructions:
- You do not need to define, set up, or specify the workspace directory. Assume you are already inside the default workspace directory /root, which is ready for app creation.
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
    model: anthropic({
      model: "claude-3-5-haiku-20241022",
      defaultParameters: {
        max_tokens: 1024,
      },
    }),
    tools: [
      shellTool,
      codeRunTool,
      uploadFilesTool,
      readFileTool,
      deleteFileTool,
      createDirectoryTool,
      deleteDirectoryTool,
      startDevServerTool,
      checkDevServerHealthTool,
    ],
  });

  const network = createNetwork({
    name: "coding-agent-network",
    agents: [codingAgent],
    maxIter: 30,
    defaultRouter: ({ network, callCount }) => {
      const previousIterationMessageContent = extractTextMessageContent(
        network.state.results.at(-1)
      );
      if (previousIterationMessageContent)
        logDebug(`Iteration message:\n${previousIterationMessageContent}\n`);
      console.log(`\n ===== Iteration #${callCount + 1} =====\n`);
      if (callCount > 0) {
        if (previousIterationMessageContent.includes("TASK_COMPLETED")) {
          const isDevServerAppMessage = network.state.results
            .map((result) => extractTextMessageContent(result))
            .findLast((messageContent) =>
              messageContent.includes("DEV_SERVER_PORT")
            );
          if (isDevServerAppMessage) {
            const portMatch = isDevServerAppMessage.match(
              /DEV_SERVER_PORT=([0-9]+)/
            );
            const port =
              portMatch && portMatch[1]
                ? parseInt(portMatch[1], 10)
                : undefined;
            if (port) network.state.data.devServerPort = port;
          }
          return;
        }
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
      const previewInfo = await sandbox.ports.previewLink(devServerPort);
      console.log(
        "\x1b[32m✔ App is ready!\x1b[0m\n\x1b[36mPreview: " +
          previewInfo.url +
          "\x1b[0m"
      );
    } else await sandbox.delete();
  } catch (error) {
    console.error("An error occurred during the final phase:", error);
  }
}

main();
