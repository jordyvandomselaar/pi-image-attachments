import type { ContentBlock, ImageContent } from "./content.ts";
import {
	createImageAttachmentEditor,
	type AttachmentEditorDeps,
	type DraftAttachment,
	type PendingSubmission,
} from "./editor-factory.ts";
import { PREFER_INLINE_SCREENSHOT_PROMPT } from "./prompt.ts";
import { upgradeScreenshotToolResult } from "./tool-result-upgrader.ts";

export type PiLike = {
	on(event: string, handler: (event: any, ctx: ExtensionContextLike) => any): void;
	sendUserMessage(content: string | ContentBlock[], options?: { deliverAs?: "steer" | "followUp" }): void;
};

export type ExtensionContextLike = {
	cwd: string;
	isIdle(): boolean;
	ui: {
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		setEditorComponent(factory: ((...args: any[]) => any) | undefined): void;
		getEditorComponent?(): ((...args: any[]) => any) | undefined;
	};
};

// Consumer-supplied deps. Internal `getHooks` is injected by the runtime below.
export type ExtensionRuntimeDeps = Omit<AttachmentEditorDeps, "getHooks"> & {
	loadImageContentFromPath: (filePath: string) => Promise<ImageContent | null>;
};

const EXTENSION_WIDGET_KEY = "image-attachments";

export function registerImageAttachmentsExtension(pi: PiLike, deps: ExtensionRuntimeDeps): void {
	let currentDraftAttachments: DraftAttachment[] = [];
	let pendingSubmission: PendingSubmission | undefined;
	let currentCtx: ExtensionContextLike | undefined;

	const refreshWidget = (ctx: ExtensionContextLike) => {
		if (currentDraftAttachments.length === 0) {
			ctx.ui.setWidget(EXTENSION_WIDGET_KEY, undefined);
			return;
		}

		const lines = [
			"Attached images:",
			...currentDraftAttachments.map((attachment) => `${attachment.placeholder} ${attachment.label}`),
		];
		ctx.ui.setWidget(EXTENSION_WIDGET_KEY, lines, { placement: "aboveEditor" });
	};

	// Hooks are bound to module-level state via a closure rather than passed as a
	// constructor arg. This keeps the editor class's constructor signature compatible
	// with the standard `(tui, theme, keybindings)` shape, so other extensions can
	// safely subclass it without having to know about our hook arg.
	const getHooks = () => ({
		publishDraft: (attachments: DraftAttachment[]) => {
			currentDraftAttachments = [...attachments];
			if (currentCtx) refreshWidget(currentCtx);
		},
		queuePendingSubmission: (submission: PendingSubmission) => {
			pendingSubmission = submission;
		},
		sendImagesOnly: (images: ImageContent[]) => {
			currentDraftAttachments = [];
			pendingSubmission = undefined;
			if (currentCtx) refreshWidget(currentCtx);
			pi.sendUserMessage(images, currentCtx?.isIdle() ?? true ? undefined : { deliverAs: "steer" });
		},
	});

	const installEditor = (ctx: ExtensionContextLike) => {
		currentCtx = ctx;
		// Composability: if a previous extension has already installed a custom editor,
		// extend its class instead of CustomEditor so its overrides remain in the chain.
		// See https://github.com/badlogic/pi-mono/issues/3935
		const previous = ctx.ui.getEditorComponent?.();

		ctx.ui.setEditorComponent((...args: any[]) => {
			let BaseEditor = deps.BaseEditor;
			if (previous) {
				// Probe the previous factory once to obtain its class. The probe instance is
				// discarded; the actual editor is constructed below via `new EditorClass(...)`,
				// which fires each constructor in the chain exactly once for the mounted instance.
				const probe = previous(...args);
				const probeCtor = probe?.constructor;
				if (typeof probeCtor === "function") {
					BaseEditor = probeCtor as typeof BaseEditor;
				}
			}

			const EditorClass = createImageAttachmentEditor({ ...deps, BaseEditor, getHooks });
			return new EditorClass(...args);
		});
		refreshWidget(ctx);
	};

	const resetDraft = (ctx: ExtensionContextLike) => {
		currentDraftAttachments = [];
		pendingSubmission = undefined;
		ctx.ui.setWidget(EXTENSION_WIDGET_KEY, undefined);
	};

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PREFER_INLINE_SCREENSHOT_PROMPT}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		installEditor(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetDraft(ctx);
		installEditor(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		return upgradeScreenshotToolResult(event, ctx.cwd, deps.loadImageContentFromPath);
	});

	pi.on("input", async (event, ctx) => {
		if (pendingSubmission && event.text === pendingSubmission.matchText) {
			const submission = pendingSubmission;
			const mergedImages = [...(event.images ?? []), ...submission.images];
			pendingSubmission = undefined;
			currentDraftAttachments = [];
			refreshWidget(ctx);
			return {
				action: "transform" as const,
				text: submission.transformedText,
				images: mergedImages,
			};
		}

		return { action: "continue" as const };
	});
}
