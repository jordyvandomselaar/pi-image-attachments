import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	collectTextContent,
	createImagePlaceholder,
	extractSavedScreenshotPaths,
	hasInlineImageContent,
	inferMimeType,
	isClipboardTempFile,
	isScreenshotToolName,
	isScreenshotToolResult,
	looksLikeImagePath,
	normalizePastedPath,
	removeImagePlaceholders,
	resolveMaybeRelativePath,
	sortByPlaceholderNumber,
	stripOuterQuotes,
} from "../src/path-utils.ts";

describe("path-utils", () => {
	test("normalizes pasted paths and file URLs", () => {
		expect(normalizePastedPath("  '/tmp/example.png'  ")).toBe("/tmp/example.png");
		expect(normalizePastedPath('"/tmp/example two.png"')).toBe("/tmp/example two.png");
		expect(normalizePastedPath("/tmp/example\\ file.png")).toBe("/tmp/example file.png");
		expect(normalizePastedPath("file:///tmp/example.png")).toBe("/tmp/example.png");
		expect(normalizePastedPath("   ")).toBeNull();
		expect(stripOuterQuotes("'abc'"))
			.toBe("abc");
		expect(stripOuterQuotes("abc")).toBe("abc");
	});

	test("detects supported image paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-path-utils-"));
		const imagePath = path.join(dir, "image.png");
		const textPath = path.join(dir, "notes.txt");
		fs.writeFileSync(imagePath, Buffer.from("png-data"));
		fs.writeFileSync(textPath, "hello");

		expect(inferMimeType(imagePath)).toBe("image/png");
		expect(inferMimeType(textPath)).toBeNull();
		expect(looksLikeImagePath(imagePath)).toBe(true);
		expect(looksLikeImagePath(textPath)).toBe(false);
		expect(resolveMaybeRelativePath("images/file.png", "/repo")).toBe(path.resolve("/repo", "images/file.png"));
		expect(resolveMaybeRelativePath(imagePath, "/repo")).toBe(imagePath);
	});

	test("handles placeholders, content extraction, and screenshot detection", () => {
		const attachments = sortByPlaceholderNumber([
			{ placeholder: createImagePlaceholder(2) },
			{ placeholder: createImagePlaceholder(1) },
		]);
		expect(attachments.map((item) => item.placeholder)).toEqual(["[Image #1]", "[Image #2]"]);
		expect(removeImagePlaceholders("Look [Image #2] at [Image #1] now")).toBe("Look at now");

		const content = [
			{ type: "text", text: "hello" } as const,
			{ type: "image", data: "abc", mimeType: "image/png" } as const,
			{ type: "text", text: "world" } as const,
		];
		expect(collectTextContent(content)).toBe("hello\nworld");
		expect(hasInlineImageContent(content)).toBe(true);
		expect(hasInlineImageContent([{ type: "text", text: "only text" }])).toBe(false);

		expect(isScreenshotToolName("take_screenshot")).toBe(true);
		expect(isScreenshotToolName("chrome_devtools_take_screenshot")).toBe(true);
		expect(isScreenshotToolName("something_else")).toBe(false);
		expect(isScreenshotToolResult({ toolName: "mcp", details: { tool: "take_screenshot" } })).toBe(true);
		expect(isScreenshotToolResult({ toolName: "mcp", details: { tool: "other" } })).toBe(false);
	});

	test("extracts saved screenshot paths and temp clipboard files", () => {
		const tmpImage = path.join(os.tmpdir(), "pi-clipboard-example.png");
		expect(isClipboardTempFile(tmpImage)).toBe(true);
		expect(isClipboardTempFile("/tmp/not-clipboard.png")).toBe(false);

		const text = [
			"Took a screenshot.",
			"Saved screenshot to /tmp/first.png.",
			"Saved screenshot to relative/second.webp",
		].join("\n");
		expect(extractSavedScreenshotPaths(text)).toEqual(["/tmp/first.png", "relative/second.webp"]);
	});
});
