import type { ImportedTerminalImage } from "../../ipc/terminalImages.ts";

export const MAX_TERMINAL_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_IMAGE_PIXELS = 16_000_000;
export const MAX_TERMINAL_IMAGE_SIDE = 16_384;
export const TERMINAL_IMAGE_RENDER_SIDE = 4_096;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export type TerminalImageTargetKey = `terminal:${string}` | `agent:${string}`;

export function terminalImageTargetKey(kind: "terminal" | "agent", id: string): TerminalImageTargetKey {
  return `${kind}:${id}`;
}

export interface TerminalImageState {
  available: boolean;
  busy: boolean;
  error: string | null;
  revision: number;
}

interface TerminalImageRegistration {
  key: TerminalImageTargetKey;
  generation: number;
  host: HTMLElement;
  importImage: (pngBase64: string) => Promise<ImportedTerminalImage>;
  discardImage: (imported: ImportedTerminalImage) => Promise<void>;
  beginAttachment?: () => () => void;
  pasteInsertion: (insertion: string, beforeWrite: () => void, terminalGeneration?: number) => Promise<void>;
  focus: () => void;
}

export interface RegisterTerminalImageTarget {
  key: TerminalImageTargetKey;
  importImage: (pngBase64: string) => Promise<ImportedTerminalImage>;
  /** Releases a native-staged image if its exact terminal never accepted the paste. */
  discardImage: (imported: ImportedTerminalImage) => Promise<void>;
  /** Captures the live runtime selected at the user gesture and returns its later guard. */
  beginAttachment?: () => () => void;
  /** Paste at the current cursor through the terminal's ordered input lane. Never submits. */
  pasteInsertion: (insertion: string, beforeWrite: () => void, terminalGeneration?: number) => Promise<void>;
  focus: () => void;
}

interface ImageDescription {
  format: "png" | "jpeg" | "webp";
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

const UNAVAILABLE: TerminalImageState = Object.freeze({ available: false, busy: false, error: null, revision: 0 });
const registrations = new Map<TerminalImageTargetKey, TerminalImageRegistration>();
const states = new Map<TerminalImageTargetKey, TerminalImageState>();
const listeners = new Map<TerminalImageTargetKey, Set<() => void>>();
let nextGeneration = 1;
let activePreparations = 0;

export class TerminalImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TerminalImageError";
  }
}

function notify(key: TerminalImageTargetKey) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function setState(key: TerminalImageTargetKey, patch: Omit<TerminalImageState, "revision">) {
  const previous = states.get(key) ?? UNAVAILABLE;
  states.set(key, { ...patch, revision: previous.revision + 1 });
  notify(key);
}

export function terminalImageState(key: TerminalImageTargetKey): TerminalImageState {
  return states.get(key) ?? UNAVAILABLE;
}

export function subscribeTerminalImageState(key: TerminalImageTargetKey, listener: () => void): () => void {
  let entries = listeners.get(key);
  if (!entries) {
    entries = new Set();
    listeners.set(key, entries);
  }
  entries.add(listener);
  return () => {
    entries?.delete(listener);
    if (entries?.size === 0) listeners.delete(key);
  };
}

function current(registration: TerminalImageRegistration): boolean {
  return (
    registration.host.isConnected &&
    registrations.get(registration.key)?.generation === registration.generation &&
    registrations.get(registration.key) === registration
  );
}

function requireCurrent(registration: TerminalImageRegistration) {
  if (!current(registration)) {
    throw new TerminalImageError("target_closed", "That terminal changed before the image could be attached.");
  }
}

function safeMessage(cause: unknown): string {
  if (cause instanceof TerminalImageError) return cause.message;
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return cause.message;
  }
  return "KalCode couldn't attach that image.";
}

function fail(registration: TerminalImageRegistration, cause: unknown) {
  if (!current(registration)) return;
  setState(registration.key, { available: true, busy: false, error: safeMessage(cause) });
  registration.focus();
}

function droppedFiles(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []);
}

function hasFileItems(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file");
}

function clipboardImage(event: ClipboardEvent): File | null {
  const items = Array.from(event.clipboardData?.items ?? []);
  for (const item of items) {
    if (item.kind === "file" && item.type.toLowerCase().startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(event.clipboardData?.files ?? [])) {
    if (file.type.toLowerCase().startsWith("image/")) return file;
  }
  return null;
}

/**
 * Registers one mounted xterm without owning its lifecycle. Image paste is intercepted only when
 * the clipboard exposes an image File; text-only paste remains entirely xterm-native.
 */
export function registerTerminalImageTarget(host: HTMLElement, target: RegisterTerminalImageTarget): () => void {
  const registration: TerminalImageRegistration = { ...target, host, generation: nextGeneration++ };
  registrations.set(target.key, registration);
  setState(target.key, { available: true, busy: false, error: null });

  const onPaste = (event: ClipboardEvent) => {
    if (event.defaultPrevented) return;
    const image = clipboardImage(event);
    if (!image) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void attachForRegistration(registration, image);
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFileItems(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    host.dataset.terminalImageDrop = "active";
  };
  const onDragLeave = (event: DragEvent) => {
    if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    delete host.dataset.terminalImageDrop;
  };
  const onDrop = (event: DragEvent) => {
    const files = droppedFiles(event);
    const file = files[0];
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    delete host.dataset.terminalImageDrop;
    if (files.length !== 1) {
      fail(registration, new TerminalImageError("image_count_invalid", "Attach one image at a time."));
      return;
    }
    void attachForRegistration(registration, file);
  };

  // Capture wins over xterm's textarea paste listener only for image clipboard items.
  host.addEventListener("paste", onPaste, true);
  host.addEventListener("dragover", onDragOver);
  host.addEventListener("dragleave", onDragLeave);
  host.addEventListener("drop", onDrop);
  return () => {
    host.removeEventListener("paste", onPaste, true);
    host.removeEventListener("dragover", onDragOver);
    host.removeEventListener("dragleave", onDragLeave);
    host.removeEventListener("drop", onDrop);
    delete host.dataset.terminalImageDrop;
    if (registrations.get(target.key) === registration) {
      registrations.delete(target.key);
      setState(target.key, { available: false, busy: false, error: null });
    }
  };
}

export function focusTerminalImageTarget(key: TerminalImageTargetKey) {
  registrations.get(key)?.focus();
}

export async function attachTerminalImage(key: TerminalImageTargetKey, file: File): Promise<boolean> {
  const registration = registrations.get(key);
  if (!registration || !current(registration)) return false;
  return attachForRegistration(registration, file);
}

async function attachForRegistration(registration: TerminalImageRegistration, file: File): Promise<boolean> {
  if (!current(registration)) return false;
  if (terminalImageState(registration.key).busy) {
    setState(registration.key, {
      available: true,
      busy: true,
      error: "Wait for the current image to finish attaching.",
    });
    registration.focus();
    return false;
  }
  if (activePreparations >= 2) {
    fail(
      registration,
      new TerminalImageError("image_import_capacity", "Two images are already attaching. Try again in a moment."),
    );
    return false;
  }
  activePreparations += 1;
  setState(registration.key, { available: true, busy: true, error: null });
  registration.host.dataset.imageBusy = "true";
  let imported: ImportedTerminalImage | null = null;
  let delivered = false;
  try {
    const guardTarget = registration.beginAttachment?.() ?? (() => undefined);
    guardTarget();
    const pngBase64 = await normalizeTerminalImage(file);
    guardTarget();
    requireCurrent(registration);
    imported = await registration.importImage(pngBase64);
    requireCurrent(registration);
    await registration.pasteInsertion(
      imported.insertion,
      () => {
        requireCurrent(registration);
        guardTarget();
      },
      imported.terminalGeneration,
    );
    delivered = true;
    requireCurrent(registration);
    setState(registration.key, { available: true, busy: false, error: null });
    registration.focus();
    return true;
  } catch (cause) {
    fail(registration, cause);
    return false;
  } finally {
    if (imported && !delivered) {
      try {
        await registration.discardImage(imported);
      } catch {
        // Preserve the original import/paste error; managed storage cleanup is best-effort here.
      }
    }
    activePreparations -= 1;
    if (current(registration)) delete registration.host.dataset.imageBusy;
  }
}

function byte(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0;
}

function u16be(bytes: Uint8Array, at: number): number {
  return byte(bytes, at) * 0x100 + byte(bytes, at + 1);
}

function u24le(bytes: Uint8Array, at: number): number {
  return byte(bytes, at) + byte(bytes, at + 1) * 0x100 + byte(bytes, at + 2) * 0x1_0000;
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    byte(bytes, at) * 0x1_000000 + byte(bytes, at + 1) * 0x1_0000 + byte(bytes, at + 2) * 0x100 + byte(bytes, at + 3)
  );
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    byte(bytes, at) + byte(bytes, at + 1) * 0x100 + byte(bytes, at + 2) * 0x1_0000 + byte(bytes, at + 3) * 0x1_000000
  );
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function pngDescription(bytes: Uint8Array): ImageDescription | null {
  if (
    bytes.length < 24 ||
    ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n" ||
    ascii(bytes, 12, 4) !== "IHDR" ||
    u32be(bytes, 8) !== 13
  ) {
    return null;
  }
  return { format: "png", mime: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegDescription(bytes: Uint8Array): ImageDescription | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (at + 1 >= bytes.length) return null;
    const length = u16be(bytes, at);
    if (length < 2 || at + length > bytes.length) return null;
    const frame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (frame) {
      if (length < 7) return null;
      return { format: "jpeg", mime: "image/jpeg", width: u16be(bytes, at + 5), height: u16be(bytes, at + 3) };
    }
    at += length;
  }
  return null;
}

function webpDescription(bytes: Uint8Array): ImageDescription | null {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const chunk = ascii(bytes, at, 4);
    const length = u32le(bytes, at + 4);
    const data = at + 8;
    if (data + length > bytes.length) return null;
    if (chunk === "VP8X" && length >= 10) {
      return {
        format: "webp",
        mime: "image/webp",
        width: u24le(bytes, data + 4) + 1,
        height: u24le(bytes, data + 7) + 1,
      };
    }
    if (
      chunk === "VP8 " &&
      length >= 10 &&
      bytes[data + 3] === 0x9d &&
      bytes[data + 4] === 0x01 &&
      bytes[data + 5] === 0x2a
    ) {
      return {
        format: "webp",
        mime: "image/webp",
        width: (byte(bytes, data + 6) + byte(bytes, data + 7) * 0x100) & 0x3fff,
        height: (byte(bytes, data + 8) + byte(bytes, data + 9) * 0x100) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      const b1 = byte(bytes, data + 1);
      const b2 = byte(bytes, data + 2);
      const b3 = byte(bytes, data + 3);
      const b4 = byte(bytes, data + 4);
      return {
        format: "webp",
        mime: "image/webp",
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    at = data + length + (length % 2);
  }
  return null;
}

export function inspectTerminalImage(bytes: Uint8Array): ImageDescription {
  const description = pngDescription(bytes) ?? jpegDescription(bytes) ?? webpDescription(bytes);
  if (!description) {
    throw new TerminalImageError("image_format_unsupported", "Choose a PNG, JPEG, or WebP image.");
  }
  const { width, height } = description;
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_TERMINAL_IMAGE_SIDE ||
    height > MAX_TERMINAL_IMAGE_SIDE ||
    width * height > MAX_TERMINAL_IMAGE_PIXELS
  ) {
    throw new TerminalImageError(
      "image_dimensions_invalid",
      "That image is too large. Use an image up to 16 megapixels.",
    );
  }
  return description;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, Math.min(bytes.length, at + chunk)));
  }
  return btoa(binary);
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new TerminalImageError("image_encode_failed", "KalCode couldn't prepare that image.");
  return blob;
}

async function loadImage(
  blob: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Some macOS WebViews expose createImageBitmap but cannot decode every supported format.
    }
  }
  const image = new Image();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  image.src = `data:${blob.type};base64,${bytesToBase64(bytes)}`;
  await image.decode();
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => undefined,
  };
}

function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function transcodePng(bytes: Uint8Array, description: ImageDescription): Promise<Uint8Array> {
  if (typeof document === "undefined") {
    throw new TerminalImageError("image_decode_unavailable", "Image attachments aren't available in this window.");
  }
  const sourceBytes = bytes.slice().buffer;
  let loaded: Awaited<ReturnType<typeof loadImage>>;
  try {
    loaded = await loadImage(new Blob([sourceBytes], { type: description.mime }));
  } catch {
    throw new TerminalImageError("image_decode_failed", "That image couldn't be decoded.");
  }
  try {
    // The decoded dimensions are authoritative too; orientation may swap width and height.
    if (
      loaded.width < 1 ||
      loaded.height < 1 ||
      loaded.width > MAX_TERMINAL_IMAGE_SIDE ||
      loaded.height > MAX_TERMINAL_IMAGE_SIDE ||
      loaded.width * loaded.height > MAX_TERMINAL_IMAGE_PIXELS
    ) {
      throw new TerminalImageError(
        "image_dimensions_invalid",
        "That image is too large. Use an image up to 16 megapixels.",
      );
    }
    let size = scaledSize(loaded.width, loaded.height, TERMINAL_IMAGE_RENDER_SIDE);
    const canvas = document.createElement("canvas");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new TerminalImageError("image_decode_unavailable", "KalCode couldn't prepare that image.");
      context.drawImage(loaded.source, 0, 0, size.width, size.height);
      const png = await canvasPng(canvas);
      if (png.size <= MAX_TERMINAL_IMAGE_BYTES) return new Uint8Array(await png.arrayBuffer());
      const ratio = Math.min(0.9, Math.max(0.5, Math.sqrt(MAX_TERMINAL_IMAGE_BYTES / png.size) * 0.95));
      const next = {
        width: Math.max(1, Math.floor(size.width * ratio)),
        height: Math.max(1, Math.floor(size.height * ratio)),
      };
      if (next.width === size.width && next.height === size.height) break;
      size = next;
    }
    throw new TerminalImageError("image_too_large", "That image is too detailed to attach within the 8 MB limit.");
  } finally {
    loaded.close();
  }
}

export async function normalizeTerminalImage(file: File): Promise<string> {
  if (file.size < 1) throw new TerminalImageError("image_empty", "That image is empty.");
  if (file.size > MAX_SOURCE_BYTES) {
    throw new TerminalImageError("image_source_too_large", "Choose an image smaller than 32 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const description = inspectTerminalImage(bytes);
  const png =
    description.format === "png" &&
    bytes.length <= MAX_TERMINAL_IMAGE_BYTES &&
    Math.max(description.width, description.height) <= TERMINAL_IMAGE_RENDER_SIDE
      ? bytes
      : await transcodePng(bytes, description);
  if (png.length > MAX_TERMINAL_IMAGE_BYTES) {
    throw new TerminalImageError("image_too_large", "That image is too detailed to attach within the 8 MB limit.");
  }
  return bytesToBase64(png);
}

/** Test isolation for the process-local target registry. */
export function resetTerminalImageTargetsForTests() {
  registrations.clear();
  states.clear();
  listeners.clear();
  nextGeneration = 1;
  activePreparations = 0;
}
