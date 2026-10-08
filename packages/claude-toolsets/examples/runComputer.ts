/**
 * Run the computer toolset on a Daytona sandbox desktop, driven by the model through the tool runner.
 *
 * Usage:
 *
 *     npx tsx examples/runComputer.ts "Open a terminal, run date, and tell me the output."
 *     npx tsx examples/runComputer.ts --yes "..."   # approve every action without asking
 *
 * It creates a sandbox (deleted when the run ends), hands `DaytonaComputer` to
 * `client.beta.messages.toolRunner`, and prints each of the model's messages until it finishes.
 * Before each action other than a screenshot it shows you the call and runs it only if you answer y,
 * through the toolset's `confirm` option.
 *
 * Needs `ANTHROPIC_API_KEY` and `DAYTONA_API_KEY`. `MODEL` picks the model.
 */
import { createInterface } from "node:readline/promises";

import Anthropic from "@anthropic-ai/sdk";
import type { BetaComputerConfirmContext } from "@anthropic-ai/sdk/helpers/beta/toolsets";

import { DaytonaComputer } from "../src/index.js";

const TASK = "Open a terminal, run `date`, and tell me exactly what it printed.";

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const approveEverything = argv.includes("--yes");
  const task = argv.filter((word) => word !== "--yes").join(" ") || TASK;

  const prompts = createInterface({ input: process.stdin, output: process.stdout });
  const confirm = async (context: BetaComputerConfirmContext): Promise<boolean> => {
    if (approveEverything || context.member === "screenshot") return true;
    const call = JSON.stringify(context.input); // escapes control chars
    const answer = await prompts.question(`Allow ${context.member} ${call}? [y/N] `);
    return answer.trim().toLowerCase() === "y";
  };

  const client = new Anthropic();
  const computer = await DaytonaComputer.create({ confirm });
  try {
    console.log(`sandbox ${computer.sandbox.id}, screen ${computer.width}x${computer.height}`);
    const runner = client.beta.messages.toolRunner({
      model: process.env["MODEL"] ?? "claude-sonnet-5-5",
      max_tokens: 4096,
      tools: [computer],
      messages: [{ role: "user", content: task }],
    });
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "text") console.log(`[text] ${block.text}`);
        else if (block.type === "tool_use") console.log(`[${block.name}] ${JSON.stringify(block.input)}`);
      }
    }
  } finally {
    prompts.close();
    await computer.close();
  }
};

await main();
