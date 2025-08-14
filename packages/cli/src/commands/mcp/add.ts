/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'gemini mcp add' command
import type { CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { MCPServerConfig } from '@google/gemini-cli-core';

async function addMcpServer(
  name: string,
  commandOrUrl: string,
  args: Array<string | number> | undefined,
  options: {
    scope: string;
    transport: string;
    env: string[] | undefined;
    header: string[] | undefined;
    timeout?: number;
    trust?: boolean;
    description?: string;
    includeTools?: string[];
    excludeTools?: string[];
  },
) {
  const {
    scope,
    transport,
    env,
    header,
    timeout,
    trust,
    description,
    includeTools,
    excludeTools,
  } = options;
  const settingsScope =
    scope === 'user' ? SettingScope.User : SettingScope.Workspace;
  const settings = loadSettings(process.cwd());

  let newServer: Partial<MCPServerConfig> = {};

  const headers = header?.reduce(
    (acc, curr) => {
      const [key, ...valueParts] = curr.split(':');
      const value = valueParts.join(':').trim();
      if (key.trim() && value) {
        acc[key.trim()] = value;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  switch (transport) {
    case 'sse':
      newServer = {
        url: commandOrUrl,
        headers,
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
      };
      break;
    case 'http':
      newServer = {
        httpUrl: commandOrUrl,
        headers,
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
      };
      break;
    case 'stdio':
    default:
      newServer = {
        command: commandOrUrl,
        args: args?.map(String),
        env: env?.reduce(
          (acc, curr) => {
            const [key, value] = curr.split('=');
            if (key && value) {
              acc[key] = value;
            }
            return acc;
          },
          {} as Record<string, string>,
        ),
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
      };
      break;
  }

  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};

  const isExistingServer = !!mcpServers[name];
  if (isExistingServer) {
    console.log(
      `MCP server "${name}" is already configured within ${scope} settings.`,
    );
  }

  mcpServers[name] = newServer as MCPServerConfig;

  settings.setValue(settingsScope, 'mcpServers', mcpServers);

  if (isExistingServer) {
    console.log(`MCP server "${name}" updated in ${scope} settings.`);
  } else {
    console.log(
      `MCP server "${name}" added to ${scope} settings. (${transport})`,
    );
  }
}

export const addCommand: CommandModule = {
  command: 'add <name> [commandOrUrl] [args...]',
  describe: 'Add a server',
  builder: (yargs) =>
    yargs
      .usage('Usage: gemini mcp add [options] <name> <commandOrUrl> [args...]')
      .parserConfiguration({
        'populate--': true,
        'unknown-options-as-args': true,
      })
      .check((argv) => {
        // Allow the -- case by checking if we have args after --
        const doubleHyphenArgs = (argv as Record<string, unknown>)['--'] as
          | string[]
          | undefined;
        if (
          !argv.commandOrUrl &&
          doubleHyphenArgs &&
          doubleHyphenArgs.length > 0
        ) {
          // Case: gemini mcp add name -- command arg1 arg2
          return true;
        }
        if (
          argv.commandOrUrl &&
          doubleHyphenArgs &&
          doubleHyphenArgs.length > 0
        ) {
          // Case: gemini mcp add name command -- arg1 arg2
          return true;
        }
        // Normal validation - ensure we have commandOrUrl
        if (!argv.commandOrUrl) {
          throw new Error("Missing required argument 'commandOrUrl'");
        }
        return true;
      })
      .positional('name', {
        describe: 'Name of the server',
        type: 'string',
        demandOption: true,
      })
      .positional('commandOrUrl', {
        describe: 'Command (stdio) or URL (sse, http)',
        type: 'string',
        demandOption: false,
      })
      .option('scope', {
        alias: 's',
        describe: 'Configuration scope (user or project)',
        type: 'string',
        default: 'project',
        choices: ['user', 'project'],
      })
      .option('transport', {
        alias: 't',
        describe: 'Transport type (stdio, sse, http)',
        type: 'string',
        default: 'stdio',
        choices: ['stdio', 'sse', 'http'],
      })
      .option('env', {
        alias: 'e',
        describe: 'Set environment variables (e.g. -e KEY=value)',
        type: 'array',
        string: true,
      })
      .option('header', {
        alias: 'H',
        describe:
          'Set HTTP headers for SSE and HTTP transports (e.g. -H "X-Api-Key: abc123" -H "Authorization: Bearer abc123")',
        type: 'array',
        string: true,
      })
      .option('timeout', {
        describe: 'Set connection timeout in milliseconds',
        type: 'number',
      })
      .option('trust', {
        describe:
          'Trust the server (bypass all tool call confirmation prompts)',
        type: 'boolean',
      })
      .option('description', {
        describe: 'Set the description for the server',
        type: 'string',
      })
      .option('include-tools', {
        describe: 'A comma-separated list of tools to include',
        type: 'array',
        string: true,
      })
      .option('exclude-tools', {
        describe: 'A comma-separated list of tools to exclude',
        type: 'array',
        string: true,
      }),
  handler: async (argv) => {
    let commandOrUrl = argv.commandOrUrl as string;
    let args = argv.args as Array<string | number>;

    // Handle case where command comes after -- (with populate-- enabled, they go to argv['--'])
    const doubleHyphenArgs = (argv as Record<string, unknown>)['--'] as
      | string[]
      | undefined;
    if (!commandOrUrl && doubleHyphenArgs && doubleHyphenArgs.length > 0) {
      // Case: gemini mcp add name -- command arg1 arg2
      commandOrUrl = doubleHyphenArgs[0] as string;
      args = doubleHyphenArgs.slice(1);
    } else if (
      commandOrUrl &&
      doubleHyphenArgs &&
      doubleHyphenArgs.length > 0
    ) {
      // Case: gemini mcp add name command -- arg1 arg2
      args = doubleHyphenArgs;
    }

    await addMcpServer(argv.name as string, commandOrUrl, args, {
      scope: argv.scope as string,
      transport: argv.transport as string,
      env: argv.env as string[],
      header: argv.header as string[],
      timeout: argv.timeout as number | undefined,
      trust: argv.trust as boolean | undefined,
      description: argv.description as string | undefined,
      includeTools: argv.includeTools as string[] | undefined,
      excludeTools: argv.excludeTools as string[] | undefined,
    });
  },
};
