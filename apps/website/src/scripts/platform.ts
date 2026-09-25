/**
 * Marks the visitor's operating system on <html data-os="…"> so the download page can highlight
 * the matching row. Detection is best-effort and purely cosmetic: every row stays visible.
 */
import { detectOs } from "../lib/os";

const os = detectOs();
if (os) document.documentElement.dataset.os = os;
