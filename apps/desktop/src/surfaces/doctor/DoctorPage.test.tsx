import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DoctorApi, DoctorRun } from "../../ipc/doctor.ts";
import { DoctorPage } from "./DoctorPage.tsx";

function run(status: DoctorRun["status"] = "completed"): DoctorRun {
  return {
    id: "run-1",
    status,
    startedAt: "2026-09-25T12:00:00Z",
    finishedAt: status === "running" ? null : "2026-09-25T12:00:01Z",
    areas: ["kalcode"],
    workspaceId: "workspace-1",
    workspaceName: "KalCode",
    timeoutMs: 15_000,
    checks: [
      {
        id: "kalcode.database",
        area: "kalcode",
        title: "Database integrity",
        status: status === "running" ? "running" : "passed",
        summary: status === "running" ? "Checking…" : "Database integrity passed.",
        reason: null,
        durationMs: status === "running" ? null : 1,
        findingCodes: [],
      },
    ],
    findings: [],
    counts: {
      critical: 0,
      warning: 0,
      info: 0,
      ignored: 0,
      passed: status === "running" ? 0 : 1,
      couldNotCheck: 0,
      skipped: 0,
    },
    persistent: true,
  };
}

function api(overrides: Partial<DoctorApi> = {}): DoctorApi {
  return {
    run: vi.fn().mockResolvedValue(run("running")),
    cancel: vi.fn().mockResolvedValue(run("cancelled")),
    last: vi.fn().mockResolvedValue(null),
    previewFix: vi.fn(),
    fix: vi.fn(),
    ignore: vi.fn(),
    ignored: vi.fn().mockResolvedValue({ items: [], persistent: true }),
    revert: vi.fn(),
    fixLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("DoctorPage", () => {
  it("starts a bounded run for the active canonical workspace", async () => {
    const user = userEvent.setup();
    const doctor = api();
    render(<DoctorPage api={doctor} workspaceId="workspace-1" />);

    await user.click(screen.getByRole("button", { name: "Run checks" }));

    await waitFor(() => expect(doctor.run).toHaveBeenCalledWith({ areas: [], checks: [], workspaceId: "workspace-1" }));
    expect(await screen.findByText("Database integrity")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("does not expose native failure text in the surface", async () => {
    const user = userEvent.setup();
    const doctor = api({ run: vi.fn().mockRejectedValue(new Error("token=private-value")) });
    render(<DoctorPage api={doctor} />);

    await user.click(screen.getByRole("button", { name: "Run checks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Environment Doctor could not start. No changes were made.",
    );
    expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
  });
});
