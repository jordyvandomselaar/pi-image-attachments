# @jordyvd/pi-image-attachments

A distributable Pi extension package that brings image attachment behavior to Pi without any external runtime dependency beyond Pi itself.

## Features

- `Ctrl+V` clipboard images attach as draft images instead of leaving temp-file paths in the editor.
- Dragging or pasting a local image path into the editor attaches it.
- Draft images are shown as `[Image #N]` placeholders.
- Placeholders are stripped from the submitted text; only the image content is sent.
- Drafts containing only image placeholders are sent as image-only user messages.
- Screenshot tool results that save to `filePath` are promoted into inline image content so the agent can inspect them agentically.
- The extension nudges Pi to prefer inline screenshots when the agent needs to inspect the image itself.

## Demo

[Watch the screen recording demo](https://github.com/jordyvandomselaar/pi-image-attachments/blob/main/media/pi-image-attachments-demo-2026-03-17.mp4)

## Install

From npm (recommended):

```bash
pi install npm:@jordyvd/pi-image-attachments
```

From source:

```bash
git clone https://github.com/jordyvandomselaar/pi-image-attachments.git
pi install ./pi-image-attachments
```

Try without installing:

```bash
pi -e npm:@jordyvd/pi-image-attachments
```

You can also point Pi at a local checkout while developing the extension.

## Package structure

This package uses Pi's `pi.extensions` manifest in `package.json`, so Pi can load it from npm, git, or a local path.

The npm publish is intentionally limited by the `files` whitelist in `package.json`, so repo-only assets like `media/pi-image-attachments-demo-2026-03-17.mp4` are kept out of the published package.

## Composability with other custom-editor extensions

Pi 0.71+ exposes [`ctx.ui.getEditorComponent()`](https://github.com/badlogic/pi-mono/issues/3935), which lets extensions wrap a previously installed custom editor instead of replacing it. This package opts in: when another extension (for example, [`pi-vim`](https://www.npmjs.com/package/pi-vim)) has already installed a custom editor, image-attachments composes its overrides on top of that editor's class rather than collapsing back to the default `CustomEditor`.

Practically: load order in `settings.json` no longer determines which extension wins. Whichever extension runs `session_start` first becomes the inner editor, and the next one wraps it.

## Tests

```bash
bun test
bun test --coverage --coverage-reporter=text --coverage-reporter=lcov
```
