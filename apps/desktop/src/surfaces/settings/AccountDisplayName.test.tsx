import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountUiError } from "../../account/accountState.ts";
import type { PublicAccount } from "../../ipc/account.ts";
import { AccountDisplayName, displayNameErrorMessage } from "./AccountDisplayName.tsx";

const account: PublicAccount = {
  id: "acct_01",
  email: "kaleb@example.com",
  activatedAt: "2026-09-25T12:00:00Z",
  displayName: "Kaleb Campbell",
};

const field = () => screen.getByRole("textbox", { name: "Display name" });
const save = () => screen.getByRole("button", { name: "Save" });

describe("AccountDisplayName", () => {
  it("edits in place and saves the trimmed name with one click", async () => {
    const onSave = vi.fn(async (_name: string): Promise<AccountUiError | null> => null);
    // Like AccountProvider: the account shows the new name as soon as Save is pressed.
    function Live() {
      const [current, setCurrent] = useState(account);
      return (
        <AccountDisplayName
          account={current}
          onSave={(name) => {
            setCurrent({ ...current, displayName: name || null });
            return onSave(name);
          }}
        />
      );
    }
    render(<Live />);
    expect(field()).toHaveValue("Kaleb Campbell");
    expect(save()).toBeDisabled();
    await userEvent.clear(field());
    await userEvent.type(field(), "  Kaleb ");
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith("Kaleb");
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(field()).toHaveValue("Kaleb");
    expect(save()).toBeDisabled();
  });

  it("saves with Enter, and Escape puts back the saved name", async () => {
    const onSave = vi.fn(async (): Promise<AccountUiError | null> => null);
    render(<AccountDisplayName account={account} onSave={onSave} />);
    await userEvent.type(field(), " Jr{Escape}");
    expect(field()).toHaveValue("Kaleb Campbell");
    await userEvent.type(field(), " Jr{Enter}");
    expect(onSave).toHaveBeenCalledWith("Kaleb Campbell Jr");
  });

  it("explains a failed save, keeps the typed name and lets Save try again", async () => {
    const onSave = vi
      .fn<(name: string) => Promise<AccountUiError | null>>()
      .mockResolvedValueOnce({
        code: "account_service_unavailable",
        message: "KalCode could not reach the account service.",
        retryable: true,
      })
      .mockResolvedValueOnce(null);
    render(<AccountDisplayName account={account} onSave={onSave} />);
    await userEvent.clear(field());
    await userEvent.type(field(), "Kaleb");
    await userEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your name wasn't changed: KalCode couldn't reach your account. Check your connection, then select Save again.",
    );
    expect(field()).toHaveValue("Kaleb");
    await userEvent.click(save());
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("validates as you type and never sends an invalid name", async () => {
    const onSave = vi.fn(async (): Promise<AccountUiError | null> => null);
    render(<AccountDisplayName account={account} onSave={onSave} />);
    await userEvent.clear(field());
    await userEvent.type(field(), "x".repeat(65));
    expect(screen.getByText("Use at most 64 characters.")).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(save()).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("clears to the email name when saved empty, and says what it falls back to", async () => {
    const onSave = vi.fn(async (): Promise<AccountUiError | null> => null);
    const { rerender } = render(<AccountDisplayName account={account} onSave={onSave} />);
    await userEvent.clear(field());
    expect(field()).toHaveAttribute("placeholder", "kaleb");
    await userEvent.click(save());
    expect(onSave).toHaveBeenCalledWith("");
    rerender(<AccountDisplayName account={{ ...account, displayName: null }} onSave={onSave} />);
    expect(screen.getByText(/Until you set one, KalCode uses “kaleb”/)).toBeInTheDocument();
  });

  it("shows a name saved elsewhere unless the field is being edited", async () => {
    const onSave = vi.fn(async (): Promise<AccountUiError | null> => null);
    const { rerender } = render(<AccountDisplayName account={account} onSave={onSave} />);
    rerender(<AccountDisplayName account={{ ...account, displayName: "KC" }} onSave={onSave} />);
    expect(field()).toHaveValue("KC");
    await userEvent.type(field(), "!");
    rerender(<AccountDisplayName account={{ ...account, displayName: "Other" }} onSave={onSave} />);
    expect(field()).toHaveValue("KC!");
  });

  it("gives every failure a next action", () => {
    for (const code of ["invalid_display_name", "rate_limited", "authentication_required", "x"]) {
      expect(displayNameErrorMessage({ code, message: "m", retryable: false })).toMatch(
        /Use at most 64 characters|Save again|Sign in again|Save to try again/,
      );
    }
  });
});
