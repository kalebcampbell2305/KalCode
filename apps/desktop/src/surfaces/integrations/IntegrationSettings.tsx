import { useEffect, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import styles from "./IntegrationHub.module.css";
import { IntegrationHub, type ScopeChoice } from "./IntegrationHub.tsx";
import { IntegrationWorkbench } from "./IntegrationWorkbench.tsx";

export function useIntegrationScopes(workspaceId?: string) {
  const { client } = useRuntime();
  const [scopes, setScopes] = useState<ScopeChoice[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([client.listWorkspaces(), client.listThreads()])
      .then(([workspaces, threads]) => {
        if (!live) return;
        setScopes(
          workspaces
            .filter((workspace) => !workspaceId || workspace.id === workspaceId)
            .flatMap((workspace): ScopeChoice[] => [
              ...threads
                .filter(
                  (thread) =>
                    thread.workspaceId === workspace.id &&
                    thread.runtimeKind === "interactive_pty" &&
                    (thread.providerId === "claude-code" || thread.providerId === "codex") &&
                    !thread.archivedAt,
                )
                .map(
                  (thread): ScopeChoice => ({
                    label: `${workspace.name} · ${thread.name} (${thread.providerName})`,
                    scope: { workspace_id: workspace.id, surface: "code", session_id: thread.id },
                  }),
                ),
              {
                label: `${workspace.name} · KalVoice`,
                scope: { workspace_id: workspace.id, surface: "kalvoice", session_id: "kalvoice" },
              },
            ]),
        );
      })
      .catch(() => {
        if (live) setScopes([]);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return scopes;
}

export function IntegrationSettings() {
  const scopes = useIntegrationScopes();
  const [selected, setSelected] = useState("");
  return (
    <>
      <IntegrationHub scopes={scopes} />
      <div className={styles.workbench}>
        <label>
          Try a connection in context
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Choose a workspace and workflow</option>
            {scopes.map((choice, i) => (
              <option key={`${choice.scope.workspace_id}:${choice.scope.surface}:${choice.scope.session_id}`} value={i}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <IntegrationWorkbench scope={selected === "" ? null : (scopes[Number(selected)]?.scope ?? null)} />
    </>
  );
}

export function CodeIntegrationPanel({ workspaceId }: { workspaceId: string }) {
  const scopes = useIntegrationScopes(workspaceId).filter((choice) => choice.scope.surface === "code");
  const [selected, setSelected] = useState("");
  return (
    <div>
      <div className={styles.workbench}>
        <label>
          Coding agent
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Choose a coding agent</option>
            {scopes.map((choice) => (
              <option key={choice.scope.session_id} value={choice.scope.session_id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <IntegrationWorkbench scope={scopes.find((choice) => choice.scope.session_id === selected)?.scope ?? null} />
    </div>
  );
}
