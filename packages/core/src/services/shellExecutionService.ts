/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pty from '@lydell/node-pty';
import { TextDecoder } from 'util';
import { spawn } from 'child_process';
import { getCachedEncodingForBuffer } from '../utils/systemEncoding.js';
import { isBinary } from '../utils/textUtils.js';
import { getShellConfiguration, isWindows } from '../utils/shell-utils.js';
import pkg from '@xterm/headless';
const { Terminal } = pkg;

const SIGKILL_TIMEOUT_MS = 200;

/** Type definition for the headless terminal instance. */
type HeadlessTerminalInstance = InstanceType<typeof Terminal>;

/**
 * Retrieves the full text content from the terminal buffer, interpreting ANSI codes
 * and trimming whitespace. Relies on Proposed API being enabled.
 */
const getFullText = (terminal: HeadlessTerminalInstance) => {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.join('\n').trim();
};

/** A structured result from a shell command execution. */
export interface ShellExecutionResult {
  /** The raw, unprocessed output buffer. */
  rawOutput: Buffer;
  /** The combined, decoded output (stdout + stderr) as a string, with ANSI codes processed by a headless terminal. */
  output: string;
  /** The process exit code, or null if terminated by a signal. */
  exitCode: number | null;
  /** The signal (number) that terminated the process, if any (e.g., 9 for SIGKILL). */
  signal: number | null;
  /** An error object if the process failed to spawn. */
  error: Error | null;
  /** A boolean indicating if the command was aborted by the user. */
  aborted: boolean;
  /** The process ID of the spawned shell. */
  pid: number | undefined;
}

/** A handle for an ongoing shell execution. */
export interface ShellExecutionHandle {
  /** The process ID of the spawned shell. */
  pid: number | undefined;
  /** A promise that resolves with the complete execution result. */
  result: Promise<ShellExecutionResult>;
}

/**
 * Describes a structured event emitted during shell command execution.
 */
export type ShellOutputEvent =
  | {
      /**
       * The event contains the current visible state of the terminal output.
       * Note: Due to PTY usage, stdout and stderr are merged.
       * This chunk contains the *entire* processed output so far.
       */
      type: 'data';
      /** The decoded string content of the terminal buffer. */
      chunk: string;
    }
  | {
      /** Signals that the output stream has been identified as binary. */
      type: 'binary_detected';
    }
  | {
      /** Provides progress updates for a binary stream. */
      type: 'binary_progress';
      /** The total number of bytes received so far. */
      bytesReceived: number;
    };

/**
 * A centralized service for executing shell commands with robust process
 * management, cross-platform compatibility, and streaming output capabilities.
 *
 */
export class ShellExecutionService {
  /**
   * Executes a shell command using `node-pty`, capturing all output and lifecycle events.
   *
   * @param commandToExecute The exact command string to run.
   * @param cwd The working directory to execute the command in.
   * @param onOutputEvent A callback for streaming structured events about the execution.
   * @param abortSignal An AbortSignal to terminate the process and its children.
   * @param terminalColumns Optional width of the pseudo-terminal.
   * @param terminalRows Optional height of the pseudo-terminal.
   * @returns A handle containing the PID and a promise resolving with the result.
   */
  static execute(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    terminalColumns?: number,
    terminalRows?: number,
  ): ShellExecutionHandle {
    // Determine the shell configuration (executable and required arguments)
    const { executable, argsPrefix } = getShellConfiguration();
    const args = [...argsPrefix, commandToExecute];

    const COLS = terminalColumns ?? 200;
    const ROWS = terminalRows ?? 20;

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(executable, args, {
        cwd,
        name: 'xterm-color',
        cols: COLS,
        rows: ROWS,
        env: {
          ...process.env,
          GEMINI_CLI: '1',
          // Force color output as we are running in a PTY.
          FORCE_COLOR: '1',
        },
        handleFlowControl: true,
        // Crucial: Set encoding to null to receive raw Buffers.
        encoding: null,
      });
    } catch (e) {
      const error = e as Error;
      return {
        pid: undefined,
        result: Promise.resolve({
          rawOutput: Buffer.from(''),
          output: '',
          exitCode: 1,
          signal: null,
          error,
          aborted: false,
          pid: undefined,
        }),
      };
    }

    const result = new Promise<ShellExecutionResult>((resolve) => {
      const headlessTerminal = new Terminal({
        allowProposedApi: true,
        cols: COLS,
        rows: ROWS,
      });

      // Ensures sequential processing of data chunks, required for xterm state management.
      let processingChain = Promise.resolve();
      let decoder: TextDecoder | null = null;
      let output = '';
      const outputChunks: Buffer[] = [];
      const error: Error | null = null;
      let exited = false;

      let isStreamingRawContent = true;
      const MAX_SNIFF_SIZE = 4096;
      let sniffedBytes = 0;

      const handleOutput = (data: Buffer) => {
        // NOTE: Because we are using a PTY, stdout and stderr are merged into this single stream.
        processingChain = processingChain.then(
          () =>
            new Promise<void>((resolveChunk) => {
              if (!decoder) {
                // Detect encoding on the first chunk of data.
                const encoding = getCachedEncodingForBuffer(data);
                try {
                  decoder = new TextDecoder(encoding);
                } catch {
                  // Fallback if detected encoding is unsupported.
                  decoder = new TextDecoder('utf-8');
                }
              }

              outputChunks.push(data);

              // Binary detection logic.
              if (isStreamingRawContent && sniffedBytes < MAX_SNIFF_SIZE) {
                // Sniff based on the accumulated buffer (limited scope for efficiency)
                const sniffBuffer = Buffer.concat(outputChunks.slice(0, 20));
                sniffedBytes = sniffBuffer.length;

                if (isBinary(sniffBuffer)) {
                  isStreamingRawContent = false;
                  onOutputEvent({ type: 'binary_detected' });
                }
              }

              // Process data based on the current mode (text or binary).
              if (isStreamingRawContent) {
                // Decode buffer chunk, handling potential split multi-byte characters.
                const decodedChunk = decoder.decode(data, { stream: true });

                // Normalize line endings to CRLF (\r\n) before writing to xterm.
                const normalizedChunk = decodedChunk.replace(/\r?\n/g, '\r\n');

                // Write to the headless terminal to process ANSI codes.
                headlessTerminal.write(normalizedChunk, () => {
                  const newStrippedOutput = getFullText(headlessTerminal);
                  // Optimization: Only emit if the actual visible content has changed.
                  if (newStrippedOutput !== output) {
                    output = newStrippedOutput;
                    onOutputEvent({ type: 'data', chunk: newStrippedOutput });
                  }
                  resolveChunk();
                });
              } else {
                // Binary mode: only emit progress events.
                const totalBytes = outputChunks.reduce(
                  (sum, chunk) => sum + chunk.length,
                  0,
                );
                onOutputEvent({
                  type: 'binary_progress',
                  bytesReceived: totalBytes,
                });
                resolveChunk();
              }
            }),
        );
      };

      // Handle the type discrepancy between definition and runtime.
      ptyProcess.onData((data: string) => {
        handleOutput(data as unknown as Buffer);
      });

      ptyProcess.onExit(
        ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
          exited = true;
          abortSignal.removeEventListener('abort', abortHandler);

          // Wait for all output processing to complete before resolving.
          processingChain.then(() => {
            // Final decoder flush for any remaining bytes (crucial for stream: true).
            if (decoder && isStreamingRawContent) {
              const finalDecoded = decoder.decode();
              if (finalDecoded.length > 0) {
                // Apply the same normalization to the final flush.
                const normalizedFinal = finalDecoded.replace(/\r?\n/g, '\r\n');

                headlessTerminal.write(normalizedFinal, () => {
                  const finalOutput = getFullText(headlessTerminal);
                  if (finalOutput !== output) {
                    output = finalOutput;
                    // Emit the final state if it changed during the flush.
                    onOutputEvent({ type: 'data', chunk: output });
                  }
                  finalize(exitCode, signal);
                });
                return;
              }
            }
            finalize(exitCode, signal);
          });
        },
      );

      const finalize = (exitCode: number, signal: number | undefined) => {
        headlessTerminal.dispose();

        const finalBuffer = Buffer.concat(outputChunks);
        resolve({
          rawOutput: finalBuffer,
          output,
          exitCode,
          signal: signal ?? null,
          error,
          aborted: abortSignal.aborted,
          pid: ptyProcess.pid,
        });
      };

      // Robust cross-platform process termination logic.
      const abortHandler = async () => {
        if (ptyProcess.pid && !exited) {
          if (isWindows) {
            // Windows: Use taskkill to forcefully terminate the process tree (/t /f).
            try {
              // Use child_process.spawn for taskkill itself.
              spawn('taskkill', [
                '/pid',
                ptyProcess.pid.toString(),
                '/f',
                '/t',
              ]);
            } catch (_) {
              // Fallback if taskkill fails to spawn
              if (!exited) ptyProcess.kill();
            }
          } else {
            // Unix: Use process group killing (negative PID). node-pty ensures the process is a group leader.
            try {
              // 1. Graceful shutdown attempt (SIGTERM).
              process.kill(-ptyProcess.pid, 'SIGTERM');
              // 2. Wait briefly.
              await new Promise((res) => setTimeout(res, SIGKILL_TIMEOUT_MS));
              // 3. Forceful shutdown (SIGKILL) if still running.
              if (!exited) {
                process.kill(-ptyProcess.pid, 'SIGKILL');
              }
            } catch (_) {
              // Fall back if group kill fails (e.g., process already dead (ESRCH), or permission issues)
              if (!exited) {
                try {
                  ptyProcess.kill('SIGKILL');
                } catch (_) {
                  // ignore errors during fallback kill
                }
              }
            }
          }
        }
      };

      if (abortSignal.aborted) {
        abortHandler();
      } else {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    });

    return { pid: ptyProcess.pid, result };
  }
}
