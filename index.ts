/**
 * pi-imgcat — display images inline in pi, imgcat-style.
 *
 * Tool:    show_image  (LLM-driven)
 * Command: /img <path|url|data:uri>  (manual, sin gastar un turno del LLM)
 *
 * Rendering:
 *   - iTerm2 / Kitty / WezTerm / Ghostty: pi-tui renders the tool result's
 *     { type: "image" } content inline, cropped to the configured width —
 *     no custom code needed there. Over SSH from iTerm2 set
 *     PI_IMAGE_PROTOCOL=iterm2 (ITERM_SESSION_ID no se propaga por SSH).
 *   - Windows Terminal (pi-tui has no protocol there): Sixel via the
 *     PowerShell `Sixel` module (Install-Module Sixel -Scope CurrentUser).
 *   - Anything else: plain text label.
 *
 * Sixel helpers adapted from pi-image-tools 1.4.0 (MIT, MasuRii).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	calculateImageRows,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "pi-imgcat-image";
const MAX_BYTES = 20 * 1024 * 1024;
const PS_TIMEOUT_MS = 120_000;
const PS_MAX_BUFFER = 128 * 1024 * 1024;
const MAX_WIDTH_CELLS = 60; // default de terminal.imageWidthCells
const MAX_SIXEL_ROWS = 80;

const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

interface ThemeLike {
	fg(color: string, text: string): string;
}

interface ResolvedImage {
	bytes: Buffer;
	mimeType: string;
	label: string;
}

interface ImgcatDetails {
	source: string;
	resolved: string;
	mimeType: string;
	bytes: number;
	caption?: string;
	image: { data: string; mimeType: string };
	sixel?: { sequence: string; rows: number };
	art?: string[]; // half-blocks ANSI (fallback universal)
}

// ─────────────────────────────────────────────────────────────────────────
// Source resolution: local path | http(s) URL | data: URI
// ─────────────────────────────────────────────────────────────────────────

function normalizeMime(raw: string): string | undefined {
	const mime = raw.split(";")[0].trim().toLowerCase();
	if (mime === "image/jpg") return "image/jpeg";
	return SUPPORTED_MIMES.has(mime) ? mime : undefined;
}

async function resolveSource(source: string, cwd: string, signal?: AbortSignal): Promise<ResolvedImage> {
	if (source.startsWith("data:")) {
		const comma = source.indexOf(",");
		if (comma < 0) throw new Error("data: URI has no payload");
		const meta = source.slice(5, comma);
		const payload = source.slice(comma + 1);
		const mime = normalizeMime(meta.split(";")[0] ?? "");
		if (!mime) throw new Error(`data: URI with unsupported MIME: ${meta.split(";")[0]}`);
		if (!meta.includes("base64")) throw new Error("data: URI must be base64");
		return { bytes: Buffer.from(payload, "base64"), mimeType: mime, label: "data:uri" };
	}

	if (/^https?:\/\//i.test(source)) {
		const res = await fetch(source, { signal });
		if (!res.ok) throw new Error(`HTTP ${res.status} al bajar ${source}`);
		const mime = normalizeMime(res.headers.get("content-type") ?? "");
		if (!mime) {
			throw new Error(`URL is not a supported image (content-type: ${res.headers.get("content-type") ?? "?"})`);
		}
		return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: mime, label: source };
	}

	const expanded = source
		.replace(/^~(?=\/|\\|$)/, homedir())
		.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m); // %TEMP% etc. (Windows); URLs never reach this branch
	const p = path.resolve(cwd, expanded);
	let bytes: Buffer;
	try {
		bytes = await fs.promises.readFile(p);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException)?.code ?? "";
		throw new Error(`cannot read ${p}${code ? ` (${code})` : ""}`);
	}
	const mimeType = await detectSupportedImageMimeTypeFromFile(p);
	if (!mimeType) throw new Error(`${p} is not a supported image (png/jpeg/gif/webp/bmp)`);
	return { bytes, mimeType, label: p };
}

async function resolveImage(source: string, cwd: string, signal?: AbortSignal): Promise<ResolvedImage> {
	const resolved = await resolveSource(source, cwd, signal);
	if (resolved.bytes.length === 0) throw new Error("empty image");
	if (resolved.bytes.length > MAX_BYTES) {
		throw new Error(
			`image of ${resolved.bytes.length.toLocaleString()} bytes exceeds the ${MAX_BYTES.toLocaleString()} byte limit`,
		);
	}
	return resolved;
}

// ─────────────────────────────────────────────────────────────────────────
// Sixel helpers (adapted from pi-image-tools 1.4.0, MIT)
// ─────────────────────────────────────────────────────────────────────────

const SIXEL_IMAGE_LINE_MARKER = "\x1b_Gm=0;\x1b\\";
const SIXEL_DCS_PREFIX = "\x1bP";
const STRING_TERMINATOR = "\x1b\\";

function ensureCompleteSixelSequence(value: string): string {
	let normalized = value.replace(/\r?\n/g, "").replace(/\s+$/g, "");
	if (normalized.length === 0) return "";
	if (!normalized.startsWith(SIXEL_DCS_PREFIX)) {
		normalized = `${SIXEL_DCS_PREFIX}${normalized.startsWith("q") ? normalized : `q${normalized}`}`;
	}
	if (!normalized.endsWith(STRING_TERMINATOR)) {
		normalized = `${normalized}${STRING_TERMINATOR}`;
	}
	return normalized;
}

function buildSixelRenderLines(sequence: string, rows: number): string[] {
	const safeRows = Math.max(1, Math.min(Math.trunc(rows), MAX_SIXEL_ROWS));
	const complete = ensureCompleteSixelSequence(sequence);
	if (complete.length === 0) return [];
	const lines = Array.from({ length: Math.max(0, safeRows - 1) }, () => "");
	const moveUp = safeRows > 1 ? `\x1b[${safeRows - 1}A` : "";
	return [...lines, `${SIXEL_IMAGE_LINE_MARKER}${moveUp}${complete}`];
}

class SixelImageComponent implements Component {
	constructor(
		private readonly sequence: string,
		private readonly rows: number,
	) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return buildSixelRenderLines(this.sequence, this.rows);
	}
}

class RawLinesComponent implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

function escapePowerShellSingleQuoted(s: string): string {
	return s.replace(/'/g, "''");
}

function runPowerShell(script: string): Promise<string> {
	return new Promise((resolve) => {
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const child = spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded], { windowsHide: true });
		let stdout = "";
		let settled = false;
		const finish = (out: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(out);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish("");
		}, PS_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < PS_MAX_BUFFER) stdout += chunk.toString("utf8");
		});
		child.on("error", () => finish(""));
		child.on("close", () => finish(stdout));
	});
}

async function convertToSixel(bytes: Buffer, mimeType: string): Promise<string | undefined> {
	const ext = MIME_EXT[mimeType] ?? "png";
	const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-imgcat-"));
	const imagePath = path.join(dir, `img.${ext}`);
	try {
		fs.writeFileSync(imagePath, bytes);
		const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$path = '${escapePowerShellSingleQuoted(imagePath)}'

Import-Module Sixel -ErrorAction Stop
if (-not (Test-Path -LiteralPath $path)) {
  throw "Image path does not exist: $path"
}

$rendered = ConvertTo-Sixel -Path $path -Protocol Sixel -Force
if ([string]::IsNullOrWhiteSpace($rendered)) {
  throw 'ConvertTo-Sixel returned empty output.'
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $rendered
`;
		const stdout = await runPowerShell(script);
		const sequence = ensureCompleteSixelSequence(stdout);
		return sequence.length > 0 ? sequence : undefined;
	} catch {
		// ponytail: silent failure → falls back to label; add logging if it ever matters
		return undefined;
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

function estimateRows(dataBase64: string, mimeType: string): number {
	const dims = getImageDimensions(dataBase64, mimeType);
	if (!dims) return 12;
	return Math.max(1, Math.min(calculateImageRows(dims, MAX_WIDTH_CELLS), MAX_SIXEL_ROWS));
}

// ─────────────────────────────────────────────────────────────────────────
// Block-art: half-blocks ANSI con truecolor — funciona en CUALQUIER terminal
// (multiplexers como Herdr se comen Sixel/Kitty/iTerm, pero esto es texto).
// Requires PowerShell/System.Drawing → Windows only.
// ─────────────────────────────────────────────────────────────────────────

function parseBmpToBlockArt(buf: Buffer): string[] | undefined {
	if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return undefined;
	const dataOffset = buf.readUInt32LE(10);
	const width = buf.readInt32LE(18);
	const heightRaw = buf.readInt32LE(22);
	if (buf.readUInt16LE(28) !== 24 || width <= 0 || heightRaw === 0) return undefined;
	const bottomUp = heightRaw > 0;
	const height = Math.abs(heightRaw);
	const stride = (width * 3 + 3) & ~3;
	const px = (x: number, y: number) => {
		const row = bottomUp ? height - 1 - y : y;
		const off = dataOffset + row * stride + x * 3;
		return { r: buf[off + 2], g: buf[off + 1], b: buf[off] };
	};
	const lines: string[] = [];
	for (let y = 0; y + 1 < height; y += 2) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const top = px(x, y);
			const bot = px(x, y + 1);
			line += `\x1b[38;2;${top.r};${top.g};${top.b};48;2;${bot.r};${bot.g};${bot.b}m▀`;
		}
		lines.push(line + "\x1b[0m");
	}
	return lines;
}

async function convertToBlockArt(bytes: Buffer, mimeType: string, dataBase64: string): Promise<string[] | undefined> {
	// ponytail: System.Drawing is Windows-only; on Linux with no protocol, label remains
	if (process.platform !== "win32") return undefined;
	const dims = getImageDimensions(dataBase64, mimeType);
	if (!dims || dims.widthPx <= 0 || dims.heightPx <= 0) return undefined;
	// cells are ~1:2 → at 60 cols, rows = 30*h/w; vertical pixels = rows*2
	let cols = MAX_WIDTH_CELLS;
	let rows = Math.round((30 * dims.heightPx) / dims.widthPx);
	if (rows > MAX_SIXEL_ROWS / 2) {
		cols = Math.max(20, Math.round((cols * (MAX_SIXEL_ROWS / 2)) / rows));
		rows = MAX_SIXEL_ROWS / 2;
	}
	rows = Math.max(1, Math.min(MAX_SIXEL_ROWS / 2, rows));
	const pixelRows = rows * 2;
	const ext = MIME_EXT[mimeType] ?? "png";
	const dir = fs.mkdtempSync(path.join(tmpdir(), "pi-imgcat-art-"));
	const srcPath = path.join(dir, `src.${ext}`);
	const bmpPath = path.join(dir, "art.bmp");
	try {
		fs.writeFileSync(srcPath, bytes);
		const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

$src = '${escapePowerShellSingleQuoted(srcPath)}'
$out = '${escapePowerShellSingleQuoted(bmpPath)}'
$cols = ${cols}; $prows = ${pixelRows}

$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap([int]$cols, [int]$prows, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($img, 0, 0, $cols, $prows)
$g.Dispose(); $img.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()
`;
		await runPowerShell(script);
		if (!fs.existsSync(bmpPath)) return undefined;
		return parseBmpToBlockArt(fs.readFileSync(bmpPath));
	} catch {
		return undefined;
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Display: label + (Sixel in WT) — in kitty/iterm2 the default pi-tui pipeline
// (imageComponents) adds the image; rendering it here would duplicate it.
// ─────────────────────────────────────────────────────────────────────────

function displayContainer(details: ImgcatDetails, theme: ThemeLike): Container {
	const caption = details.caption ? ` — ${details.caption}` : "";
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg(
				"muted",
				`imgcat: ${details.resolved} (${details.mimeType}, ${details.bytes.toLocaleString()} bytes)${caption}`,
			),
			0,
			0,
		),
	);
	if (details.sixel) {
		container.addChild(new Spacer(1));
		container.addChild(new SixelImageComponent(details.sixel.sequence, details.sixel.rows));
	} else if (details.art) {
		container.addChild(new Spacer(1));
		container.addChild(new RawLinesComponent(details.art));
	} else if (!getCapabilities().images) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("muted", "[image not renderable in this terminal — no image protocol]"), 0, 0),
		);
	}
	return container;
}

async function maybeSixel(resolved: ResolvedImage, data: string): Promise<{ sequence: string; rows: number } | undefined> {
	if (getCapabilities().images !== null || process.platform !== "win32") return undefined;
	if (process.env.HERDR_ENV) return undefined; // Herdr does not pass Sixel: the multiplexer TUI eats it
	// ponytail: sixel win32 only; add img2sixel on Linux if ever needed
	const sequence = await convertToSixel(resolved.bytes, resolved.mimeType);
	if (!sequence) return undefined;
	return { sequence, rows: estimateRows(data, resolved.mimeType) };
}

async function attachFallbackDisplay(details: ImgcatDetails, resolved: ResolvedImage, data: string): Promise<void> {
	details.sixel = await maybeSixel(resolved, data);
	if (!details.sixel) {
		details.art = await convertToBlockArt(resolved.bytes, resolved.mimeType, data);
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────

const SHOW_IMAGE_PARAMS = Type.Object({
	source: Type.String({
		minLength: 1,
		description:
			"Local path (absolute, relative to cwd, or ~/), http(s):// URL, or data: URI of the image to show.",
	}),
	caption: Type.Optional(
		Type.String({ maxLength: 200, description: "Optional one-line note shown next to the image." }),
	),
});
type ShowImageInput = Static<typeof SHOW_IMAGE_PARAMS>;

export default function imgcatExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "show_image",
		label: "Show image",
		description:
			"Show the user an image, rendered inline in the terminal (iTerm2/Kitty/WezTerm/Ghostty; Sixel in Windows Terminal; ANSI blocks in multiplexers). Use when the user asks to see an image, screenshot, plot, or diagram.",
		promptSnippet: "show_image — display an image inline in the terminal",
		promptGuidelines: [
			"Use show_image when the user asks to see an image, screenshot, plot, or diagram.",
			"Pass the literal path or URL the user gave; do not paraphrase.",
		],
		parameters: SHOW_IMAGE_PARAMS,
		renderShell: "self",
		renderResult: (result: any, _options: any, theme: any) => {
			const details = result?.details as ImgcatDetails | undefined;
			if (!details?.image) {
				const text = result?.content?.find((c: any) => c.type === "text")?.text ?? "";
				return new Text(String(text), 0, 0);
			}
			return displayContainer(details, theme as ThemeLike);
		},
		async execute(_toolCallId: string, params: ShowImageInput, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			onUpdate?.({
				content: [{ type: "text", text: `Loading ${params.source}...` }],
			});

			let resolved: ResolvedImage;
			try {
				resolved = await resolveImage(params.source, ctx.cwd, signal);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `show_image failed: ${msg}` }],
					details: { source: params.source, error: msg },
					isError: true,
				};
			}

			const data = resolved.bytes.toString("base64");
			const details: ImgcatDetails = {
				source: params.source,
				resolved: resolved.label,
				mimeType: resolved.mimeType,
				bytes: resolved.bytes.length,
				caption: params.caption,
				image: { data, mimeType: resolved.mimeType },
			};
			await attachFallbackDisplay(details, resolved, data);

			const summaryLines = [
				`Showed ${resolved.label} (${resolved.mimeType}, ${resolved.bytes.length.toLocaleString()} bytes).`,
			];
			if (params.caption) summaryLines.push(`Caption: ${params.caption}`);
			if (!getCapabilities().images) {
				if (details.sixel) summaryLines.push("Note: rendered via Sixel.");
				else if (details.art) summaryLines.push("Note: rendered via ANSI blocks (no protocol in this terminal).");
				else summaryLines.push("Note: terminal has no image protocol; showing label.");
			}

			return {
				content: [
					{ type: "text", text: summaryLines.join("\n") },
					{ type: "image", data, mimeType: resolved.mimeType },
				],
				details,
			};
		},
	});

	pi.registerMessageRenderer(CUSTOM_TYPE, (message: any, _options: any, theme: any) => {
		const details = message?.details as ImgcatDetails | undefined;
		const t = theme as ThemeLike;
		const container = new Container();
		const content = typeof message?.content === "string" ? message.content : CUSTOM_TYPE;
		container.addChild(new Text(t.fg("accent", content), 0, 0));
		if (details?.image) {
			const caps = getCapabilities();
			if (caps.images) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Image(
						details.image.data,
						details.image.mimeType,
						{ fallbackColor: (s: string) => t.fg("muted", s) },
						{ maxWidthCells: MAX_WIDTH_CELLS },
					),
				);
			} else if (details.sixel) {
				container.addChild(new Spacer(1));
				container.addChild(new SixelImageComponent(details.sixel.sequence, details.sixel.rows));
			} else if (details.art) {
				container.addChild(new Spacer(1));
				container.addChild(new RawLinesComponent(details.art));
			} else {
				container.addChild(new Spacer(1));
				container.addChild(new Text(t.fg("muted", "[image not renderable in this terminal]"), 0, 0));
			}
		}
		return container;
	});

	pi.registerCommand("img", {
		description: "Show an image inline: /img <path|url|data:uri>",
		handler: async (args: string, ctx: any) => {
			const source = args.trim();
			if (!source) {
				ctx.ui.notify("Usage: /img <path|url|data:uri>", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("imgcat: TUI mode required", "info");
				return;
			}
			let resolved: ResolvedImage;
			try {
				resolved = await resolveImage(source, ctx.cwd);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`imgcat: ${msg}`, "error");
				return;
			}
			const data = resolved.bytes.toString("base64");
			const details: ImgcatDetails = {
				source,
				resolved: resolved.label,
				mimeType: resolved.mimeType,
				bytes: resolved.bytes.length,
				image: { data, mimeType: resolved.mimeType },
			};
			await attachFallbackDisplay(details, resolved, data);
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: `imgcat: ${resolved.label} (${resolved.mimeType}, ${resolved.bytes.length.toLocaleString()} bytes)`,
					display: true,
					details,
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		},
	});
}
