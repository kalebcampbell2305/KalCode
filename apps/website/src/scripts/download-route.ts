/**
 * A direct "Download KalCode" link serves one OS's installer (data-download-os). A visitor on
 * another system (or a phone) is sent to the download page instead, where every platform is
 * listed honestly. Without JS the link stays the direct download, which is still labelled.
 */
import { detectOs } from "../lib/os";

const detected = detectOs();
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-download-os]")) {
  if (detected === link.dataset.downloadOs) continue;
  link.href = detected ? `/download#${detected}` : "/download";
  link.removeAttribute("download");
}
