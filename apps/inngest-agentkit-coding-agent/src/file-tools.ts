import { z } from "zod";
import { createTool } from "@inngest/agent-kit";
import { DaytonaError } from "@daytona/sdk";
import { getSandbox, logDebug } from "./utils.js";

export const uploadFilesTool = createTool({
  name: "uploadFilesTool",
  description: `Uploads one or more files to the Daytona sandbox. Existing contents are replaced.
Each file has a path (destination in the sandbox) and content (full UTF-8 text).
Use double quotes for the outer content string and single quotes inside source code.`,
  parameters: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string() })),
  }),
  handler: async ({ files }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      console.log("[TOOL: uploadFilesTool]");
      const result = await sandbox.fs.writeMany(Object.fromEntries(
        files.map((file) => [file.path, Buffer.from(file.content, "utf-8")])
      ));
      if (result.errors.length) return `Files create/upload errors: ${result.errors.join("; ")}`;
      const message = `Successfully created or updated files: ${files.map((f) => f.path).join(", ")}`;
      logDebug(message);
      return message;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error creating/uploading files:", error);
      if (error instanceof DaytonaError) return `Files create/upload Daytona error: ${error.message}`;
      return "Error creating/uploading files";
    }
  },
});

export const readFileTool = createTool({
  name: "readFileTool",
  description: "Reads the UTF-8 contents of a file from the Daytona sandbox.",
  parameters: z.object({ filePath: z.string() }),
  handler: async ({ filePath }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      console.log(`[TOOL: readFileTool]\nFile path: ${filePath}`);
      return Buffer.from(await sandbox.fs.read(filePath)).toString("utf-8");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error reading file:", error);
      if (error instanceof DaytonaError) return `File reading Daytona error: ${error.message}`;
      return "Error reading file";
    }
  },
});

export const deleteFileTool = createTool({
  name: "deleteFileTool",
  description: "Deletes a file from the Daytona sandbox.",
  parameters: z.object({ filePath: z.string() }),
  handler: async ({ filePath }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      await sandbox.fs.rm(filePath);
      return `Successfully deleted file: ${filePath}`;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error deleting file:", error);
      if (error instanceof DaytonaError) return `File deletion Daytona error: ${error.message}`;
      return "Error deleting file";
    }
  },
});

export const createDirectoryTool = createTool({
  name: "createDirectoryTool",
  description: "Creates a directory in the Daytona sandbox.",
  parameters: z.object({ directoryPath: z.string() }),
  handler: async ({ directoryPath }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      await sandbox.fs.mkdir(directoryPath, { mode: "755" });
      return `Successfully created directory: ${directoryPath}`;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error creating directory:", error);
      if (error instanceof DaytonaError) return `Directory creation Daytona error: ${error.message}`;
      return "Error creating directory";
    }
  },
});

export const deleteDirectoryTool = createTool({
  name: "deleteDirectoryTool",
  description: "Recursively deletes a directory from the Daytona sandbox.",
  parameters: z.object({ directoryPath: z.string() }),
  handler: async ({ directoryPath }, { network }) => {
    try {
      const sandbox = await getSandbox(network);
      await sandbox.fs.rm(directoryPath, { recursive: true });
      return `Successfully deleted directory: ${directoryPath}`;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Error deleting directory:", error);
      if (error instanceof DaytonaError) return `Directory deletion Daytona error: ${error.message}`;
      return "Error deleting directory";
    }
  },
});
