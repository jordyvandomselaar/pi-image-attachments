import { describe, expect, test } from "bun:test";
import { upgradeScreenshotToolResult } from "../src/tool-result-upgrader.ts";

describe("tool-result-upgrader", () => {
	test("ignores non-screenshot, error, already-inline, and unsaved screenshot results", async () => {
		const loadImage = async () => ({ type: "image", data: "x", mimeType: "image/png" } as const);
		expect(
			await upgradeScreenshotToolResult(
				{ toolName: "other", content: [{ type: "text", text: "Saved screenshot to /tmp/a.png" }], isError: false },
				"/cwd",
				loadImage,
			),
		).toBeUndefined();
		expect(
			await upgradeScreenshotToolResult(
				{ toolName: "take_screenshot", content: [{ type: "text", text: "Saved screenshot to /tmp/a.png" }], isError: true },
				"/cwd",
				loadImage,
			),
		).toBeUndefined();
		expect(
			await upgradeScreenshotToolResult(
				{
					toolName: "mcp",
					details: { tool: "take_screenshot" },
					content: [
						{ type: "text", text: "Saved screenshot to /tmp/a.png" },
						{ type: "image", data: "already", mimeType: "image/png" },
					],
					isError: false,
				},
				"/cwd",
				loadImage,
			),
		).toBeUndefined();
		expect(
			await upgradeScreenshotToolResult(
				{
					toolName: "take_screenshot",
					content: [{ type: "text", text: "Took a screenshot with no saved path." }],
					isError: false,
				},
				"/cwd",
				loadImage,
			),
		).toBeUndefined();
	});

	test("upgrades saved screenshot paths into inline image content", async () => {
		const result = await upgradeScreenshotToolResult(
			{
				toolName: "mcp",
				details: { tool: "take_screenshot" },
				content: [{ type: "text", text: "Saved screenshot to relative/screenshot.png." }],
				isError: false,
			},
			"/repo",
			async (filePath) => ({ type: "image", data: filePath, mimeType: "image/png" }),
		);

		expect(result).toEqual({
			content: [
				{ type: "text", text: "Saved screenshot to relative/screenshot.png." },
				{ type: "image", data: "/repo/relative/screenshot.png", mimeType: "image/png" },
			],
		});
	});

	test("adds a recovery hint when the saved screenshot cannot be read", async () => {
		const result = await upgradeScreenshotToolResult(
			{
				toolName: "take_screenshot",
				content: [
					{ type: "text", text: "Took screenshot." },
					{ type: "text", text: "Saved screenshot to /tmp/missing.png" },
				],
				isError: false,
			},
			"/repo",
			async () => null,
		);

		expect(result?.content.at(-1)).toEqual({
			type: "text",
			text:
				"[image-attachments: screenshot was saved via filePath but the image file was not readable from Pi. If you need to inspect the screenshot agentically, retry the screenshot tool without filePath so the image is returned inline.]",
		});
	});
});
