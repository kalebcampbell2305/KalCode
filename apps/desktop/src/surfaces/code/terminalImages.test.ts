import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalImage,
  inspectTerminalImage,
  MAX_TERMINAL_IMAGE_PIXELS,
  normalizeTerminalImage,
  registerTerminalImageTarget,
  resetTerminalImageTargetsForTests,
  terminalImageState,
  terminalImageTargetKey,
} from "./terminalImages.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+2pYhWQAAAABJRU5ErkJggg==";

function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function imageFile(): File {
  const bytes = bytesFromBase64(ONE_PIXEL_PNG);
  return new File([bytes.slice().buffer], "pixel.png", { type: "image/png" });
}

function jpegHeader(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03,
    0x11, 0x00,
  ]);
}

function host(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

function clipboardEvent(file?: File): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  const item = file
    ? { kind: "file", type: file.type, getAsFile: () => file }
    : { kind: "string", type: "text/plain", getAsFile: () => null };
  Object.defineProperty(event, "clipboardData", {
    value: { items: [item], files: file ? [file] : [], getData: () => (file ? "" : "plain text") },
  });
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetTerminalImageTargetsForTests();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal image admission", () => {
  it("preserves a bounded PNG exactly without decoding or losing detail", async () => {
    expect(await normalizeTerminalImage(imageFile())).toBe(ONE_PIXEL_PNG);
  });

  it("rejects unsupported, oversized, and excessive-dimension inputs before decode", async () => {
    const invalid = new File([new Uint8Array([0x47, 0x49, 0x46]).buffer], "image.gif", {
      type: "image/gif",
    });
    await expect(normalizeTerminalImage(invalid)).rejects.toMatchObject({
      code: "image_format_unsupported",
    });

    const arrayBuffer = vi.fn();
    await expect(
      normalizeTerminalImage({ size: 32 * 1024 * 1024 + 1, arrayBuffer } as unknown as File),
    ).rejects.toMatchObject({ code: "image_source_too_large" });
    expect(arrayBuffer).not.toHaveBeenCalled();

    const pngHeader = new Uint8Array(24);
    pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    pngHeader.set([0, 0, 0, 13], 8);
    pngHeader.set([0x49, 0x48, 0x44, 0x52], 12);
    pngHeader.set([0, 0, 0x10, 0], 16);
    pngHeader.set([0, 0, 0x10, 0], 20);
    expect(4096 * 4096).toBeGreaterThan(MAX_TERMINAL_IMAGE_PIXELS);
    expect(() => inspectTerminalImage(pngHeader)).toThrowError(
      expect.objectContaining({ code: "image_dimensions_invalid" }),
    );
  });

  it("recognizes JPEG and WebP dimensions from bounded headers", () => {
    expect(inspectTerminalImage(jpegHeader())).toMatchObject({ format: "jpeg", width: 3, height: 2 });

    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set([22, 0, 0, 0], 4);
    webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
    webp.set([10, 0, 0, 0], 16);
    webp.set([2, 0, 0], 24);
    webp.set([1, 0, 0], 27);
    expect(inspectTerminalImage(webp)).toMatchObject({ format: "webp", width: 3, height: 2 });
  });

  it("uses a CSP-allowed data URL when macOS falls back from createImageBitmap", async () => {
    let assignedSource = "";
    class FallbackImage {
      naturalWidth = 3;
      naturalHeight = 2;
      set src(value: string) {
        assignedSource = value;
      }
      async decode() {}
    }
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("Image", FallbackImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      const png = bytesFromBase64(ONE_PIXEL_PNG);
      callback(new Blob([png.slice().buffer], { type: "image/png" }));
    });
    const jpeg = jpegHeader();

    expect(await normalizeTerminalImage(new File([jpeg.slice().buffer], "camera.jpg", { type: "image/jpeg" }))).toBe(
      ONE_PIXEL_PNG,
    );
    expect(assignedSource).toMatch(/^data:image\/jpeg;base64,/);
    expect(assignedSource).not.toContain("blob:");
  });
});

describe("terminal image target lifecycle", () => {
  it("intercepts an image clipboard item, imports once, and pastes without submitting", async () => {
    const element = host();
    const key = terminalImageTargetKey("agent", "agent-one");
    const importImage = vi.fn(async () => ({
      imageId: "image-one",
      path: "/private/image.png",
      insertion: '"/private/image.png"',
    }));
    const discardImage = vi.fn(async () => undefined);
    const pasteInsertion = vi.fn(async (insertion: string, beforeWrite: () => void) => {
      beforeWrite();
      expect(insertion).not.toContain("\r");
      expect(insertion).not.toContain("\n");
    });
    const unregister = registerTerminalImageTarget(element, {
      key,
      importImage,
      discardImage,
      pasteInsertion,
      focus: vi.fn(),
    });

    const event = clipboardEvent(imageFile());
    expect(element.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(pasteInsertion).toHaveBeenCalledOnce());
    expect(importImage).toHaveBeenCalledExactlyOnceWith(ONE_PIXEL_PNG);
    expect(pasteInsertion.mock.calls[0]?.[0]).toBe('"/private/image.png"');
    unregister();
    expect(discardImage).not.toHaveBeenCalled();
  });

  it("leaves ordinary text paste entirely to xterm", () => {
    const element = host();
    const importImage = vi.fn();
    const pasteInsertion = vi.fn();
    registerTerminalImageTarget(element, {
      key: terminalImageTargetKey("terminal", "shell-one"),
      importImage,
      discardImage: vi.fn(),
      pasteInsertion,
      focus: vi.fn(),
    });

    const event = clipboardEvent();
    expect(element.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(importImage).not.toHaveBeenCalled();
    expect(pasteInsertion).not.toHaveBeenCalled();
  });

  it("rejects a multi-file drop without reading or importing either file", () => {
    const element = host();
    const key = terminalImageTargetKey("terminal", "shell-drop");
    const importImage = vi.fn();
    registerTerminalImageTarget(element, {
      key,
      importImage,
      discardImage: vi.fn(),
      pasteInsertion: vi.fn(),
      focus: vi.fn(),
    });
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { files: [imageFile(), imageFile()] } });

    expect(element.dispatchEvent(event)).toBe(false);
    expect(terminalImageState(key).error).toBe("Attach one image at a time.");
    expect(importImage).not.toHaveBeenCalled();
  });

  it("never pastes an import that finishes after its target unmounts", async () => {
    const element = host();
    const key = terminalImageTargetKey("terminal", "shell-stale");
    const imported = deferred<{ imageId: string; path: string; insertion: string }>();
    const importImage = vi.fn(() => imported.promise);
    const pasteInsertion = vi.fn();
    const discardImage = vi.fn(async () => undefined);
    const unregister = registerTerminalImageTarget(element, {
      key,
      importImage,
      discardImage,
      pasteInsertion,
      focus: vi.fn(),
    });

    const attaching = attachTerminalImage(key, imageFile());
    await vi.waitFor(() => expect(importImage).toHaveBeenCalledOnce());
    unregister();
    element.remove();
    const stale = { imageId: "stale-image", path: "/private/stale.png", insertion: '"/private/stale.png"' };
    imported.resolve(stale);

    await expect(attaching).resolves.toBe(false);
    expect(pasteInsertion).not.toHaveBeenCalled();
    expect(discardImage).toHaveBeenCalledExactlyOnceWith(stale);
    expect(terminalImageState(key)).toMatchObject({ available: false, busy: false });
  });

  it("keeps one import in flight and surfaces native errors without starting a second", async () => {
    const element = host();
    const key = terminalImageTargetKey("agent", "agent-busy");
    const imported = deferred<{ imageId: string; path: string; insertion: string }>();
    const importImage = vi.fn(() => imported.promise);
    const focus = vi.fn();
    registerTerminalImageTarget(element, {
      key,
      importImage,
      discardImage: vi.fn(),
      pasteInsertion: vi.fn(),
      focus,
    });

    const first = attachTerminalImage(key, imageFile());
    const second = attachTerminalImage(key, imageFile());
    await expect(second).resolves.toBe(false);
    expect(terminalImageState(key)).toMatchObject({ busy: true, error: expect.stringContaining("current image") });
    await vi.waitFor(() => expect(importImage).toHaveBeenCalledOnce());
    imported.resolve({
      imageId: "current-image",
      path: "/private/current.png",
      insertion: '"/private/current.png"',
    });
    await expect(first).resolves.toBe(true);
    expect(importImage).toHaveBeenCalledTimes(1);

    const failingKey = terminalImageTargetKey("terminal", "shell-error");
    registerTerminalImageTarget(element, {
      key: failingKey,
      importImage: vi.fn(async () => {
        throw new Error("Private image storage is unavailable.");
      }),
      discardImage: vi.fn(),
      pasteInsertion: vi.fn(),
      focus,
    });
    await expect(attachTerminalImage(failingKey, imageFile())).resolves.toBe(false);
    expect(terminalImageState(failingKey)).toMatchObject({
      busy: false,
      error: "Private image storage is unavailable.",
    });
  });

  it("bounds image preparation globally instead of queuing unbounded decoded files", async () => {
    const firstImported = deferred<{ imageId: string; path: string; insertion: string }>();
    const secondImported = deferred<{ imageId: string; path: string; insertion: string }>();
    const firstKey = terminalImageTargetKey("terminal", "capacity-one");
    const secondKey = terminalImageTargetKey("terminal", "capacity-two");
    const thirdKey = terminalImageTargetKey("terminal", "capacity-three");
    registerTerminalImageTarget(host(), {
      key: firstKey,
      importImage: () => firstImported.promise,
      discardImage: vi.fn(),
      pasteInsertion: async (_insertion, beforeWrite) => beforeWrite(),
      focus: vi.fn(),
    });
    registerTerminalImageTarget(host(), {
      key: secondKey,
      importImage: () => secondImported.promise,
      discardImage: vi.fn(),
      pasteInsertion: async (_insertion, beforeWrite) => beforeWrite(),
      focus: vi.fn(),
    });
    registerTerminalImageTarget(host(), {
      key: thirdKey,
      importImage: vi.fn(),
      discardImage: vi.fn(),
      pasteInsertion: vi.fn(),
      focus: vi.fn(),
    });

    const first = attachTerminalImage(firstKey, imageFile());
    const second = attachTerminalImage(secondKey, imageFile());
    const arrayBuffer = vi.fn();
    await expect(attachTerminalImage(thirdKey, { size: 1, arrayBuffer } as unknown as File)).resolves.toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(terminalImageState(thirdKey).error).toContain("Two images");

    firstImported.resolve({ imageId: "one", path: "/private/one.png", insertion: '"/private/one.png"' });
    secondImported.resolve({ imageId: "two", path: "/private/two.png", insertion: '"/private/two.png"' });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("discards a staged image when the guarded terminal write fails", async () => {
    const element = host();
    const key = terminalImageTargetKey("agent", "agent-write-failure");
    const imported = { imageId: "orphan", path: "/private/orphan.png", insertion: '"/private/orphan.png"' };
    const discardImage = vi.fn(async () => undefined);
    registerTerminalImageTarget(element, {
      key,
      importImage: vi.fn(async () => imported),
      discardImage,
      pasteInsertion: vi.fn(async (_insertion, beforeWrite) => {
        beforeWrite();
        throw new Error("The provider closed during delivery.");
      }),
      focus: vi.fn(),
    });

    await expect(attachTerminalImage(key, imageFile())).resolves.toBe(false);
    expect(discardImage).toHaveBeenCalledExactlyOnceWith(imported);
    expect(terminalImageState(key).error).toBe("The provider closed during delivery.");
  });
});
