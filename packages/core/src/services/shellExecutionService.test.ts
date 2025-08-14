/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';

const mockPtySpawn = vi.hoisted(() => vi.fn());
vi.mock('@lydell/node-pty', () => ({
  spawn: mockPtySpawn,
}));

const mockCpSpawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  spawn: mockCpSpawn,
}));

const mockGetShellConfiguration = vi.hoisted(() => vi.fn());
let mockIsWindows = false;
vi.mock('../utils/shell-utils.js', () => ({
  getShellConfiguration: mockGetShellConfiguration,
  get isWindows() {
    return mockIsWindows;
  },
}));

import EventEmitter from 'events';
import {
  ShellExecutionService,
  ShellOutputEvent,
} from './shellExecutionService.js';

const mockIsBinary = vi.hoisted(() => vi.fn());
vi.mock('../utils/textUtils.js', () => ({
  isBinary: mockIsBinary,
}));

const mockProcessKill = vi
  .spyOn(process, 'kill')
  .mockImplementation(() => true);

const yieldEventLoop = () => new Promise(setImmediate);

describe('ShellExecutionService', () => {
  let mockPtyProcess: EventEmitter & {
    pid: number;
    kill: Mock;
    onData: Mock;
    onExit: Mock;
  };
  let onOutputEventMock: Mock<(event: ShellOutputEvent) => void>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockIsBinary.mockReturnValue(false);

    // Setup default shell config (Linux/macOS)
    mockGetShellConfiguration.mockReturnValue({
      executable: 'bash',
      argsPrefix: ['-c'],
    });
    mockIsWindows = false;

    onOutputEventMock = vi.fn();

    // Initialize the mock PTY process
    mockPtyProcess = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: Mock;
      onData: Mock;
      onExit: Mock;
    };
    mockPtyProcess.pid = 12345;
    mockPtyProcess.kill = vi.fn();
    mockPtyProcess.onData = vi.fn();
    mockPtyProcess.onExit = vi.fn();

    mockPtySpawn.mockReturnValue(mockPtyProcess);
  });

  // Helper function to run a standard execution simulation
  const simulateExecution = async (
    command: string,
    simulation: (
      ptyProcess: typeof mockPtyProcess,
      ac: AbortController,
    ) => void | Promise<void>,
  ) => {
    const abortController = new AbortController();
    const handle = ShellExecutionService.execute(
      command,
      '/test/dir',
      onOutputEventMock,
      abortController.signal,
    );

    // Wait for initialization
    await yieldEventLoop();
    await simulation(mockPtyProcess, abortController);
    await yieldEventLoop();

    const result = await handle.result;
    return { result, handle, abortController };
  };

  describe('Successful Execution', () => {
    it('should execute a command and capture output', async () => {
      const { result, handle } = await simulateExecution('ls -l', (pty) => {
        // Input uses \n, but the service normalization (to \r\n) ensures correct display.
        pty.onData.mock.calls[0][0](Buffer.from('file1.txt\n'));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls -l'],
        expect.objectContaining({
          encoding: null, // Ensure we are requesting buffers
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('file1.txt');
      expect(handle.pid).toBe(12345);

      // The event contains the entire buffer content.
      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'data',
        chunk: 'file1.txt',
      });
    });

    it('should capture combined stdout and stderr (interleaved)', async () => {
      const { result } = await simulateExecution(
        'ls -l && echo err >&2',
        (pty) => {
          // Input uses \n, but the service normalization fixes the formatting issue seen in the failure log.
          pty.onData.mock.calls[0][0](Buffer.from('file1.txt\n'));
          pty.onData.mock.calls[0][0](Buffer.from('a warning\n'));
          pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
        },
      );

      // The output should reflect the interleaved nature.
      expect(result.output).toBe('file1.txt\na warning');

      // Events report the cumulative state of the buffer.
      expect(onOutputEventMock.mock.calls[0][0]).toEqual({
        type: 'data',
        chunk: 'file1.txt',
      });
      expect(onOutputEventMock.mock.calls[1][0]).toEqual({
        type: 'data',
        chunk: 'file1.txt\na warning',
      });
    });

    it('should strip ANSI codes from output', async () => {
      const { result } = await simulateExecution('ls --color=auto', (pty) => {
        pty.onData.mock.calls[0][0](Buffer.from('a\u001b[31mred\u001b[0mword'));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.output).toBe('aredword');
      expect(onOutputEventMock).toHaveBeenCalledWith({
        type: 'data',
        chunk: 'aredword',
      });
    });

    it('should correctly handle cursor movements and overwrites (using xterm)', async () => {
      const { result } = await simulateExecution('progress', async (pty) => {
        const onData = pty.onData.mock.calls[0][0];
        onData(Buffer.from('Progress: ['));
        // We must yield to allow the async processingChain to execute
        await yieldEventLoop();
        onData(Buffer.from('==='));
        await yieldEventLoop();
        // Move cursor back 3 positions (\u001b[3D) and overwrite
        onData(Buffer.from('\u001b[3DXXX'));
        await yieldEventLoop();
        onData(Buffer.from(']'));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      // The output should reflect the final state of the terminal buffer
      expect(result.output).toBe('Progress: [XXX]');
    });

    it('should correctly decode multi-byte characters split across chunks', async () => {
      const { result } = await simulateExecution('echo "你好"', (pty) => {
        const multiByteChar = Buffer.from('你好', 'utf-8');
        // Split the buffer in the middle of a character (e.g., after 2 bytes)
        pty.onData.mock.calls[0][0](multiByteChar.slice(0, 2));
        pty.onData.mock.calls[0][0](multiByteChar.slice(2));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });
      // TextDecoder handles the boundary correctly.
      expect(result.output).toBe('你好');
    });

    it('should handle commands with no output', async () => {
      const { result } = await simulateExecution('touch file', (pty) => {
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.output).toBe('');
      expect(onOutputEventMock).not.toHaveBeenCalled();
    });
  });

  describe('Failed Execution', () => {
    it('should capture a non-zero exit code', async () => {
      const { result } = await simulateExecution('a-bad-command', (pty) => {
        pty.onData.mock.calls[0][0](Buffer.from('command not found'));
        pty.onExit.mock.calls[0][0]({ exitCode: 127, signal: null });
      });

      expect(result.exitCode).toBe(127);
      expect(result.output).toBe('command not found');
      expect(result.error).toBeNull();
    });

    it('should capture a termination signal', async () => {
      const { result } = await simulateExecution('long-process', (pty) => {
        // Signal 15 is SIGTERM
        pty.onExit.mock.calls[0][0]({ exitCode: 143, signal: 15 });
      });

      expect(result.exitCode).toBe(143);
      expect(result.signal).toBe(15);
    });

    it('should handle a synchronous spawn error', async () => {
      const spawnError = new Error('spawn ENOENT');
      mockPtySpawn.mockImplementation(() => {
        throw spawnError;
      });

      const handle = ShellExecutionService.execute(
        'any-command',
        '/test/dir',
        onOutputEventMock,
        new AbortController().signal,
      );
      const result = await handle.result;

      expect(result.error).toBe(spawnError);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe('');
      expect(handle.pid).toBeUndefined();
    });
  });

  describe('Aborting Commands (Robust)', () => {
    it('should abort a running process on Linux/macOS (SIGTERM)', async () => {
      mockIsWindows = false;

      const { result } = await simulateExecution(
        'sleep 10',
        (pty, abortController) => {
          abortController.abort();
          // Simulate the process exiting due to the signal (15 = SIGTERM).
          pty.onExit.mock.calls[0][0]({ exitCode: 143, signal: 15 });
        },
      );

      expect(result.aborted).toBe(true);
      // Check that the process group kill was attempted.
      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockPtyProcess.pid!,
        'SIGTERM',
      );
    });

    it('should abort a running process on Windows (taskkill)', async () => {
      mockIsWindows = true;

      const { result } = await simulateExecution(
        'timeout 10',
        (pty, abortController) => {
          abortController.abort();
          // Simulate the process exiting after taskkill
          pty.onExit.mock.calls[0][0]({ exitCode: 1, signal: null });
        },
      );

      expect(result.aborted).toBe(true);
      // Check that taskkill was spawned via child_process.spawn
      expect(mockCpSpawn).toHaveBeenCalledWith('taskkill', [
        '/pid',
        String(mockPtyProcess.pid),
        '/f',
        '/t',
      ]);
    });

    it('should gracefully attempt SIGKILL on linux if SIGTERM fails', async () => {
      mockIsWindows = false;
      vi.useFakeTimers();

      const abortController = new AbortController();
      const handle = ShellExecutionService.execute(
        'unresponsive_process',
        '/test/dir',
        onOutputEventMock,
        abortController.signal,
      );

      await vi.runAllTicks();

      abortController.abort();

      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockPtyProcess.pid!,
        'SIGTERM',
      );

      await vi.advanceTimersByTimeAsync(250);

      expect(mockProcessKill).toHaveBeenCalledWith(
        -mockPtyProcess.pid!,
        'SIGKILL',
      );

      mockPtyProcess.onExit.mock.calls[0][0]({ exitCode: 137, signal: 9 });

      await vi.runAllTicks();

      const result = await handle.result;

      vi.useRealTimers();

      expect(result.aborted).toBe(true);
      expect(result.signal).toBe(9);
      expect(mockProcessKill).toHaveBeenCalledTimes(2);
    });

    it('should fall back to pty.kill if process group kill throws an error', async () => {
      mockIsWindows = false;
      mockProcessKill.mockImplementation(() => {
        throw new Error('ESRCH');
      });

      await simulateExecution('short-process', async (pty, abortController) => {
        abortController.abort();
        // Wait for the async abort handler to run
        await yieldEventLoop();

        expect(mockProcessKill).toHaveBeenCalledWith(-pty.pid, 'SIGTERM');
        // It should have fallen back to the pty specific kill method
        expect(pty.kill).toHaveBeenCalledWith('SIGKILL');

        // Simulate exit after the fallback kill
        pty.onExit.mock.calls[0][0]({ exitCode: 137, signal: 9 });
      });
    });
  });

  describe('Binary Output', () => {
    it('should detect binary output and switch to progress events', async () => {
      mockIsBinary.mockReturnValueOnce(true);
      const binaryChunk1 = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const binaryChunk2 = Buffer.from([0x0d, 0x0a, 0x1a, 0x0a]);

      const { result } = await simulateExecution('cat image.png', (pty) => {
        pty.onData.mock.calls[0][0](binaryChunk1);
        pty.onData.mock.calls[0][0](binaryChunk2);
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      expect(result.rawOutput).toEqual(
        Buffer.concat([binaryChunk1, binaryChunk2]),
      );

      expect(onOutputEventMock.mock.calls).toContainEqual([
        {
          type: 'binary_detected',
        },
      ]);

      expect(onOutputEventMock.mock.calls).toContainEqual([
        {
          type: 'binary_progress',
          bytesReceived: 8, // Total length
        },
      ]);
    });

    it('should not emit data events after binary is detected', async () => {
      mockIsBinary.mockImplementation((buffer) => buffer.includes(0x00));

      await simulateExecution('cat mixed_file', (pty) => {
        pty.onData.mock.calls[0][0](Buffer.from('some text'));
        // Chunk that triggers binary detection
        pty.onData.mock.calls[0][0](Buffer.from([0x00, 0x01, 0x02]));
        pty.onData.mock.calls[0][0](Buffer.from('more text'));
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null });
      });

      const eventTypes = onOutputEventMock.mock.calls.map(
        (call: [ShellOutputEvent]) => call[0].type,
      );

      // We expect the sequence to transition from data -> binary_detected -> binary_progress
      const detectedIndex = eventTypes.indexOf('binary_detected');
      const firstProgressIndex = eventTypes.indexOf('binary_progress');

      // The crucial check is that no 'data' events occur after 'binary_detected'.
      if (detectedIndex !== -1) {
        expect(eventTypes.slice(detectedIndex + 1)).not.toContain('data');
      }

      expect(detectedIndex).not.toBe(-1);
      expect(firstProgressIndex).toBeGreaterThanOrEqual(detectedIndex);
    });
  });

  describe('Platform-Specific Behavior', () => {
    it('should use Windows configuration', async () => {
      mockGetShellConfiguration.mockReturnValue({
        executable: 'cmd.exe',
        argsPrefix: ['/c'],
      });
      mockIsWindows = true;

      await simulateExecution('dir "foo bar"', (pty) =>
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null }),
      );

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'dir "foo bar"'],
        expect.objectContaining({
          encoding: null,
        }),
      );
    });

    it('should use Linux configuration', async () => {
      // Defaults are already set for Linux/bash in beforeEach
      mockIsWindows = false;

      await simulateExecution('ls "foo bar"', (pty) =>
        pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: null }),
      );

      expect(mockPtySpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'ls "foo bar"'],
        expect.objectContaining({
          encoding: null,
        }),
      );
    });
  });
});
