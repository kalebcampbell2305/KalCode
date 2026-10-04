import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_URL, StartupError } from "./StartupError.tsx";

const newer = {
  category: "database",
  code: "schema_too_new",
  message: "Your KalCode data was created by a newer version of KalCode. Update KalCode to open it.",
  retryable: false,
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("StartupError", () => {
  it("hands over the official download link when the data needs a newer KalCode", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<StartupError client={null} info={null} error={newer} />);
    expect(screen.getByText("kalcoded.com/download")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy download link" }));
    expect(await screen.findByRole("button", { name: "Download link copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(DOWNLOAD_URL);
    expect(screen.getByRole("status")).toHaveTextContent("Paste the link into your browser");
  });

  it("offers no download for other startup failures", () => {
    render(
      <StartupError
        client={null}
        info={null}
        error={{ category: "database", code: "database_locked", message: "Locked.", retryable: true }}
      />,
    );
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(screen.getByText(/Nothing was deleted or changed/)).toBeInTheDocument();
  });
});
