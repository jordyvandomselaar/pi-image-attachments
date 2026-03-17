import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadImageContentFromPath, maybeResizeImage, readImageContentFromPath } from "../src/image-content.ts";

describe("image-content", () => {
	test("reads image content from disk", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-content-"));
		const imagePath = path.join(dir, "sample.png");
		fs.writeFileSync(imagePath, Buffer.from("hello-image"));

		const image = readImageContentFromPath(imagePath);
		expect(image).not.toBeNull();
		expect(image).toEqual({
			type: "image",
			data: Buffer.from("hello-image").toString("base64"),
			mimeType: "image/png",
		});

		const unsupportedPath = path.join(dir, "sample.bmp");
		fs.writeFileSync(unsupportedPath, Buffer.from("bmp-data"));
		expect(readImageContentFromPath(unsupportedPath)).toBeNull();
		expect(readImageContentFromPath(path.join(dir, "missing.png"))).toBeNull();
	});

	test("optionally resizes images and falls back on errors", async () => {
		const image = { type: "image", data: "abc", mimeType: "image/png" } as const;
		expect(await maybeResizeImage(image)).toEqual(image);
		expect(
			await maybeResizeImage(image, async () => ({ type: "image", data: "resized", mimeType: "image/webp" })),
		).toEqual({ type: "image", data: "resized", mimeType: "image/webp" });
		expect(await maybeResizeImage(image, async () => {
			throw new Error("boom");
		})).toEqual(image);
	});

	test("loads and resizes image content from a path", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-load-"));
		const imagePath = path.join(dir, "sample.webp");
		fs.writeFileSync(imagePath, Buffer.from("raw-image"));

		const image = await loadImageContentFromPath(imagePath, async (input) => ({
			type: "image",
			data: `${input.data}-resized`,
			mimeType: "image/png",
		}));
		expect(image).toEqual({
			type: "image",
			data: `${Buffer.from("raw-image").toString("base64")}-resized`,
			mimeType: "image/png",
		});

		expect(await loadImageContentFromPath(path.join(dir, "missing.gif"))).toBeNull();
	});
});
