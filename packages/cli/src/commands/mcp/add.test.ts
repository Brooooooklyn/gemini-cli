/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yargs from 'yargs';
import { addCommand } from './add.js';
import { loadSettings, SettingScope } from '../../config/settings.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../../config/settings.js', async () => {
  const actual = await vi.importActual('../../config/settings.js');
  return {
    ...actual,
    loadSettings: vi.fn(),
  };
});

const mockedLoadSettings = loadSettings as vi.Mock;

describe('mcp add command', () => {
  let parser: yargs.Argv;
  let mockSetValue: vi.Mock;

  beforeEach(() => {
    vi.resetAllMocks();
    const yargsInstance = yargs([]).command(addCommand);
    parser = yargsInstance;
    mockSetValue = vi.fn();
    mockedLoadSettings.mockReturnValue({
      forScope: () => ({ settings: {} }),
      setValue: mockSetValue,
    });
  });

  it('should add a stdio server to project settings', async () => {
    await parser.parseAsync(
      'add my-server /path/to/server arg1 arg2 -e FOO=bar',
    );

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      {
        'my-server': {
          command: '/path/to/server',
          args: ['arg1', 'arg2'],
          env: { FOO: 'bar' },
        },
      },
    );
  });

  it('should add an sse server to user settings', async () => {
    await parser.parseAsync(
      'add --transport sse sse-server https://example.com/sse-endpoint --scope user -H "X-API-Key: your-key"',
    );

    expect(mockSetValue).toHaveBeenCalledWith(SettingScope.User, 'mcpServers', {
      'sse-server': {
        url: 'https://example.com/sse-endpoint',
        headers: { 'X-API-Key': 'your-key' },
      },
    });
  });

  it('should add an http server to project settings', async () => {
    await parser.parseAsync(
      'add --transport http http-server https://example.com/mcp -H "Authorization: Bearer your-token"',
    );

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      {
        'http-server': {
          httpUrl: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer your-token' },
        },
      },
    );
  });

  it('should add a server with command and args after -- separator', async () => {
    await parser.parseAsync(
      'add test-server -- npx -y https://example.com/test-mcp-server',
    );

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      {
        'test-server': {
          command: 'npx',
          args: ['-y', 'https://example.com/test-mcp-server'],
        },
      },
    );
  });

  it('should add a server with unknown options as args', async () => {
    await parser.parseAsync(
      'add python-server python3 server.py --port=8000 --verbose',
    );

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      {
        'python-server': {
          command: 'python3',
          args: ['server.py', '--port=8000', '--verbose'],
        },
      },
    );
  });

  it('should add a server with command and args after -- with command specified', async () => {
    await parser.parseAsync(
      'add test-server npx -- -y https://example.com/test-server',
    );

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      {
        'test-server': {
          command: 'npx',
          args: ['-y', 'https://example.com/test-server'],
        },
      },
    );
  });
});
