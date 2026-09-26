import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SocialAuthButtons } from "./SocialAuthButtons.tsx";

describe("SocialAuthButtons", () => {
  it("dispatches only the fixed Google and Microsoft provider identifiers", async () => {
    const startSocial = vi.fn(async () => undefined);
    render(<SocialAuthButtons busy={false} startSocial={startSocial} />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue with Microsoft" }));
    expect(startSocial.mock.calls).toEqual([["google"], ["microsoft"]]);
  });

  it("prevents duplicate starts while an account operation is active", () => {
    render(<SocialAuthButtons busy startSocial={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toBeDisabled();
  });
});
