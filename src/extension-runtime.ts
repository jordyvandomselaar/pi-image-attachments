import type { ContentBlock, ImageContent } from "./content.ts";
import {
	attachImageAttachmentBehavior,
	createImageAttachmentEditor,
	type AttachmentEditorDeps,
	type DraftAttachment,
	type EditorFactory,
	type EditorHooks,
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
		setEditorComponent(factory: EditorFactory | undefined): void;
		getEditorComponent(): EditorFactory | undefined;
	};
};

export type ExtensionRuntimeDeps = AttachmentEditorDeps & {
	loadImageContentFromPath: (filePath: string) => Promise<ImageContent | null>;
};

const EXTENSION_WIDGET_KEY = "image-attachments";

export function registerImageAttachmentsExtension(pi: PiLike, deps: ExtensionRuntimeDeps): void {
	let currentDraftAttachments: DraftAttachment[] = [];
	let pendingSubmission: PendingSubmission | undefined;
	let installedEditorFactory: EditorFactory | undefined;
	let wrappedEditorFactory: EditorFactory | undefined;

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

	const createHooks = (ctx: ExtensionContextLike): EditorHooks => ({
		publishDraft: (attachments: DraftAttachment[]) => {
			currentDraftAttachments = [...attachments];
			refreshWidget(ctx);
		},
		queuePendingSubmission: (submission: PendingSubmission) => {
			pendingSubmission = submission;
		},
		sendImagesOnly: (images: ImageContent[]) => {
			currentDraftAttachments = [];
			pendingSubmission = undefined;
			refreshWidget(ctx);
			pi.sendUserMessage(images, ctx.isIdle() ? undefined : { deliverAs: "steer" });
		},
	});

	const installEditor = (ctx: ExtensionContextLike) => {
		const currentEditorFactory = ctx.ui.getEditorComponent();
		const previousEditorFactory = currentEditorFactory === installedEditorFactory ? wrappedEditorFactory : currentEditorFactory;
		const hooks = createHooks(ctx);
		const ImageAttachmentEditor = createImageAttachmentEditor(deps, hooks);
		const editorFactory: EditorFactory = (tui, theme, keybindings) => {
			if (previousEditorFactory) {
				return attachImageAttachmentBehavior(
					previousEditorFactory(tui, theme, keybindings),
					keybindings,
					deps,
					hooks,
				);
			}

			return new ImageAttachmentEditor(tui, theme, keybindings);
		};

		wrappedEditorFactory = previousEditorFactory;
		installedEditorFactory = editorFactory;
		ctx.ui.setEditorComponent(editorFactory);
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
