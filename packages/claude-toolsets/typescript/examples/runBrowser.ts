/**
 * Run the browser toolset on Chromium in a Daytona sandbox, driven by the model through the tool
 * runner.
 *
 * Usage:
 *
 *     npx tsx examples/runBrowser.ts "Open example.com and tell me the page heading."
 *
 * It creates a sandbox (deleted when the run ends), hands `DaytonaBrowser` to
 * `client.beta.messages.toolRunner` with an example URL policy, and prints each of the model's
 * messages until it finishes. The policy admits http(s) pages on the hosts in `ALLOWED_DOMAINS`
 * (subdomains included) and the empty tab; the driver applies it to the pages' own requests too. It
 * is an example, not a production policy.
 *
 * Needs `ANTHROPIC_API_KEY` and `DAYTONA_API_KEY`. `ALLOWED_DOMAINS` (default `example.com,iana.org`)
 * and `MODEL` are read from the environment. Sandbox egress follows your Daytona organization's
 * network tier; pass `createParams` with a `domainAllowList` to narrow it further.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type { BetaURLPolicy } from "@anthropic-ai/sdk/helpers/beta/toolsets";

import { DaytonaBrowser } from "../src/index.js";

const TASK = "Open example.com and tell me the page heading.";

/** http(s) pages on the allowed hosts or their subdomains, and the empty tab. */
export const examplePolicy = (allowedHosts: readonly string[]): BetaURLPolicy => {
  // Dropped after normalizing, not before: `.` is not blank, but it normalizes to the empty
  // host, which `host.endsWith("." + allowed)` then matches for every name written as a fully
  // qualified one (`evil.test.`). One such entry would switch the allowlist off.
  const hosts = allowedHosts
    .map((host) => host.trim().toLowerCase().replace(/\.+$/u, ""))
    .filter((host) => host !== "");

  return (_context, url: string): void => {
    if (url.toLowerCase() === "about:blank") return;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(url);
    let address: URL;
    try {
      address = new URL((hasScheme ? url : `https://${url}`).replaceAll("\\", "/"));
    } catch {
      throw new ToolError("blocked: the address could not be parsed");
    }
    const host = address.hostname.toLowerCase();
    const scheme = address.protocol.replace(/:$/u, "");
    const allowed =
      (scheme === "http" || scheme === "https") &&
      hosts.some((name) => host === name || host.endsWith(`.${name}`));
    if (!allowed) throw new ToolError(`blocked: ${host || url} is not an allowed host`);
  };
};

const main = async (): Promise<void> => {
  const task = process.argv.slice(2).join(" ") || TASK;
  const allowed = (process.env["ALLOWED_DOMAINS"] ?? "example.com,iana.org").split(",");

  const client = new Anthropic();
  const browser = await DaytonaBrowser.create({ urlPolicy: examplePolicy(allowed) });
  try {
    console.log(`sandbox ${browser.sandbox.id}, allowed hosts: ${allowed.join(", ")}`);
    const runner = client.beta.messages.toolRunner({
      model: process.env["MODEL"] ?? "claude-sonnet-5-5",
      max_tokens: 4096,
      tools: [browser],
      messages: [{ role: "user", content: task }],
    });
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "text") console.log(`[text] ${block.text}`);
        else if (block.type === "tool_use") console.log(`[${block.name}] ${JSON.stringify(block.input)}`);
      }
    }
  } finally {
    await browser.close();
  }
};

await main();
