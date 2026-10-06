import { describe, expect, it } from "vitest";
import { clientNetwork, networkKey } from "../../worker/lib/client-network";

describe("client network", () => {
  it("keeps IPv4 addresses and unwraps IPv4-mapped IPv6", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
    expect(networkKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by /64 so rotating within a prefix shares one limit", () => {
    expect(networkKey("2001:db8:abcd:12:1::5")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:0DB8:abcd:0012:ffff:eeee:dddd:cccc")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkKey("::1")).toBe("0:0:0:0::/64");
  });

  it("reads Cloudflare's connecting IP, or a shared unknown bucket", () => {
    const request = (ip?: string) =>
      new Request("https://api.kalcoded.com/", { headers: ip ? { "cf-connecting-ip": ip } : {} });
    expect(clientNetwork(request(" 2001:db8:abcd:12::99 "))).toBe("2001:db8:abcd:12::/64");
    expect(clientNetwork(request())).toBe("unknown");
  });
});
