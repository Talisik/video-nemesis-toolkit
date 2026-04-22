import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type ProcessRegistry = Set<ChildProcess>;

export interface DownloadOptions {
  id: string;
  videoUrl: string;
  outputDir: string;
  ytDlpPath: string;
  maxHeight?: number;
  registry?: ProcessRegistry;
}

/**
 * Download a single video with yt-dlp. Output: {outputDir}/{id}.mp4.
 * Requires ffmpeg on PATH so yt-dlp can merge video+audio; without it you get video-only or separate files.
 * Returns true on success, false on failure.
 */
export async function downloadVideo(
  options: DownloadOptions
): Promise<boolean> {
  const {
    id,
    videoUrl,
    outputDir,
    ytDlpPath,
    maxHeight = 720,
    registry,
  } = options;

  await mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${id}.mp4`);
  const format = `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio/best[height<=${maxHeight}][ext=mp4]`;

  return new Promise<boolean>((resolve) => {
    const proc = spawn(
      ytDlpPath,
      [
        "-f",
        format,
        "-o",
        outPath,
        "--merge-output-format",
        "mp4",
        "--no-warnings",
        "--quiet",
        videoUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    registry?.add(proc);

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      registry?.delete(proc);
      console.error(`[download] spawn error for ${id}:`, err);
      resolve(false);
    });

    proc.on("close", (code) => {
      registry?.delete(proc);
      if (code !== 0) {
        console.error(
          `[download] yt-dlp exit ${code} for ${id}:`,
          stderr.slice(0, 500)
        );
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}
