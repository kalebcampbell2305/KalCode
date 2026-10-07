/**
 * The network a caller controls, for rate limits and the account-mail network budget.
 *
 * IPv4: the address. IPv6: the /64 prefix, because one end user (or one cloud VM) normally holds a
 * whole /64 and could otherwise rotate source addresses to get a fresh limit per request. Same
 * rule as the website Worker's `networkKey` (apps/website/worker/lib/router.ts).
 */
export function networkKey(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail = ""] = address.split("%")[0]?.split("::") ?? [];
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = address.includes("::") ? [...headGroups, ...Array(missing).fill("0"), ...tailGroups] : headGroups;
  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "") || "0");
  return `${prefix.join(":")}::/64`;
}

/** The caller's network from Cloudflare's `cf-connecting-ip`, or `unknown`. */
export function clientNetwork(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip ? networkKey(ip) : "unknown";
}
