import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "./process.ts";
import type { NotifyActivation, TerminalContext } from "./terminal.ts";

export interface NotifyOptions {
  subtitle?: string;
  sound?: string;
  force?: boolean;
  activation?: NotifyActivation;
  group?: string;
}

export interface Notifier {
  send(title: string, body: string, options?: NotifyOptions): Promise<void>;
}

const DEFAULT_GROUP = "pi-agent";

const APP_BUNDLE = path.join("vendor", "pi-terminal-notifier.app");
const APP_EXECUTABLE = path.join("Contents", "MacOS", "pi-terminal-notifier");

async function findNotifierApp(packageRoot: string): Promise<string | null> {
  const app = path.join(packageRoot, APP_BUNDLE);
  try {
    await access(path.join(app, APP_EXECUTABLE));
    return app;
  } catch {
    return null;
  }
}

function buildNotifyArgs(
  title: string,
  body: string,
  activation?: NotifyActivation,
  subtitle?: string,
  group?: string,
): string[] {
  const args = ["-title", title];
  if (subtitle) args.push("-subtitle", subtitle);
  args.push("-message", body || " ", "-group", group || DEFAULT_GROUP);

  if (activation?.type === "activate") args.push("-activate", activation.bundleId);
  else if (activation?.type === "execute") args.push("-execute", activation.command);

  return args;
}

async function cleanupStaleNotifiers(binary: string): Promise<void> {
  try {
    await execFile("pkill", ["-f", binary]);
  } catch {
    // No previous notifier process is running.
  }
}

export function createNotifier(packageRoot: string, terminal: TerminalContext): Notifier {
  let notifierBinary: string | null = null;
  let notifierApp: string | null = null;
  let binaryReady = false;
  let launchedViaLaunchServices = false;

  findNotifierApp(packageRoot)
    .then((app) => {
      notifierApp = app;
      notifierBinary = app === null ? null : path.join(app, APP_EXECUTABLE);
      binaryReady = true;
    })
    .catch(() => {
      binaryReady = true;
    });

  return {
    async send(title: string, body: string, options?: NotifyOptions): Promise<void> {
      if (!binaryReady || !notifierBinary) return;
      if (!options?.force && (await terminal.isVisible())) return;

      const args = buildNotifyArgs(
        title,
        body,
        options?.activation ?? terminal.getActivation(),
        options?.subtitle ?? path.basename(process.cwd()),
        options?.group,
      );

      if (options?.sound) {
        const sound = spawn(
          "afplay",
          [path.join(packageRoot, "sounds", options.sound + ".aiff")],
          { stdio: "ignore", detached: true },
        );
        // Missing sound files must not surface as an unhandled 'error' event.
        sound.on("error", () => {});
        sound.unref();
      }

      await cleanupStaleNotifiers(notifierBinary);

      // Spawned directly, the notifier's responsible process is the terminal, and
      // macOS rejects its authorization request with UNErrorDomain Code=1 without
      // ever showing a prompt: the app never reaches System Settings and every
      // notification is dropped. Launching the bundle through LaunchServices once
      // registers it and raises the prompt; direct spawns are authorized after that.
      if (!launchedViaLaunchServices && notifierApp !== null) {
        launchedViaLaunchServices = true;
        try {
          await execFile("open", ["-n", "-a", notifierApp, "--args", ...args]);
          return;
        } catch {
          // LaunchServices unavailable — fall through to the direct spawn.
        }
      }

      const child = spawn(notifierBinary, args, { stdio: "ignore", detached: true });
      // A helper that disappears mid-session (its package reinstalled or removed
      // while pi is running) reports ENOENT through the 'error' event, and an
      // unhandled 'error' event is an uncaught exception that takes down pi.
      // Give up on notifications for the rest of the session instead.
      child.on("error", () => {
        notifierBinary = null;
        notifierApp = null;
      });
      child.unref();
    },
  };
}
