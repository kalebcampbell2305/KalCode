import { Button, Field, TextInput } from "@kalcode/ui/components";
import { FolderGit2, FolderPlus, HardDriveDownload, Pencil, Trash2 } from "lucide-react";
import { AlertDialog, Dialog } from "radix-ui";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import styles from "./Rail.module.css";
import { useRail } from "./RailProvider.tsx";
import type { RailDialog } from "./RailTree.tsx";

/** Dialogs the rail opens: rename, folders, new workspace, add repository, remove. */
export function RailDialogs({ dialog, onClose }: { dialog: RailDialogHost | null; onClose: () => void }) {
  if (!dialog) return null;
  switch (dialog.kind) {
    case "rename":
      return <RenameWorkspace dialog={dialog} onClose={onClose} />;
    case "remove":
      return <RemoveWorkspace dialog={dialog} onClose={onClose} />;
    case "new-group":
      return <NewGroup dialog={dialog} onClose={onClose} />;
    case "rename-group":
      return <RenameGroup dialog={dialog} onClose={onClose} />;
    case "delete-group":
      return <DeleteGroup dialog={dialog} onClose={onClose} />;
    case "new-workspace":
      return <NewWorkspace onClose={onClose} />;
    case "add-repository":
      return <AddRepository onClose={onClose} />;
  }
}

export type RailDialogHost = RailDialog | { kind: "new-workspace" } | { kind: "add-repository" };

function Frame({
  title,
  description,
  icon,
  children,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  icon: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <div className={styles.dialogHead}>
            <span className={styles.dialogIcon} aria-hidden="true">
              {icon}
            </span>
            <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
          </div>
          {description ? (
            <Dialog.Description asChild>
              <div className={styles.dialogBody}>{description}</div>
            </Dialog.Description>
          ) : (
            <Dialog.Description className="visually-hidden">{title}</Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NameForm({
  label,
  initial,
  submitLabel,
  hint,
  allowEmpty = false,
  maxLength = 80,
  onSubmit,
  onClose,
  extra,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  hint?: ReactNode;
  allowEmpty?: boolean;
  maxLength?: number;
  onSubmit: (value: string) => Promise<boolean>;
  onClose: () => void;
  extra?: ReactNode;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const empty = value.trim() === "";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (empty && !allowEmpty)) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <form className={styles.dialogForm} onSubmit={submit}>
      <Field htmlFor={id} label={label} hint={hint}>
        <TextInput
          id={id}
          value={value}
          maxLength={maxLength}
          autoFocus
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      {extra}
      <div className={styles.dialogActions}>
        <Button variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" busy={busy} disabled={empty && !allowEmpty}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function RenameWorkspace({
  dialog,
  onClose,
}: {
  dialog: Extract<RailDialog, { kind: "rename" }>;
  onClose: () => void;
}) {
  const rail = useRail();
  const { entry } = dialog;
  return (
    <Frame
      title="Rename in the rail"
      icon={<Pencil />}
      description={
        <p>
          The rail shows this name. The folder on disk keeps its name, <code>{entry.folderName}</code>.
        </p>
      }
      onClose={onClose}
    >
      <NameForm
        label="Name"
        initial={entry.name}
        submitLabel="Save name"
        allowEmpty
        hint="Leave it empty to show the folder's name again."
        onSubmit={async (name) => (await rail.update({ workspaceId: entry.workspaceId, name })) !== null}
        onClose={onClose}
      />
    </Frame>
  );
}

function NewGroup({ dialog, onClose }: { dialog: Extract<RailDialog, { kind: "new-group" }>; onClose: () => void }) {
  const rail = useRail();
  return (
    <Frame
      title="New folder"
      icon={<FolderPlus />}
      description={
        <p>
          Folders group workspaces in the rail
          {dialog.forWorkspace ? `; “${dialog.forWorkspace.name}” moves into it` : ""}. Nothing changes on disk.
        </p>
      }
      onClose={onClose}
    >
      <NameForm
        label="Folder name"
        initial=""
        submitLabel="Create folder"
        onSubmit={async (name) => {
          const group = await rail.createGroup(name);
          if (!group) return false;
          if (dialog.forWorkspace)
            await rail.update({ workspaceId: dialog.forWorkspace.workspaceId, groupId: group.id });
          return true;
        }}
        onClose={onClose}
      />
    </Frame>
  );
}

function RenameGroup({
  dialog,
  onClose,
}: {
  dialog: Extract<RailDialog, { kind: "rename-group" }>;
  onClose: () => void;
}) {
  const rail = useRail();
  return (
    <Frame title="Rename folder" icon={<Pencil />} onClose={onClose}>
      <NameForm
        label="Folder name"
        initial={dialog.group.name}
        submitLabel="Save name"
        onSubmit={(name) => rail.renameGroup(dialog.group.id, name)}
        onClose={onClose}
      />
    </Frame>
  );
}

function NewWorkspace({ onClose }: { onClose: () => void }) {
  const { client } = useRuntime();
  const workspaces = useWorkspaces();
  const rail = useRail();
  const [error, setError] = useState<string | null>(null);
  return (
    <Frame
      title="New workspace"
      icon={<FolderPlus />}
      description={
        <p>
          KalCode creates an empty folder with this name in the place you choose next, then opens it as a workspace.
        </p>
      }
      onClose={onClose}
    >
      <NameForm
        label="Folder name"
        initial=""
        submitLabel="Choose location…"
        hint={error ?? "Letters, numbers, spaces and dashes work everywhere."}
        onSubmit={async (name) => {
          setError(null);
          try {
            const created = await client.createWorkspace(name);
            if (!created) return false;
            await workspaces.refresh();
            await rail.openWorkspace(created.id);
            return true;
          } catch (cause) {
            const message = (cause as { message?: string }).message ?? "KalCode couldn't create that folder.";
            setError(message);
            return false;
          }
        }}
        onClose={onClose}
      />
    </Frame>
  );
}

/**
 * Add repository: open a local Git repository now. Cloning from a URL is a network action the
 * Trust Kernel must evaluate (ADVANCED.md §16.4); until that path exists the dialog says so
 * plainly instead of offering a button that can't work.
 */
function AddRepository({ onClose }: { onClose: () => void }) {
  const { client } = useRuntime();
  const workspaces = useWorkspaces();
  const rail = useRail();
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    setStatus(null);
    const workspace = await workspaces.openFolder();
    if (workspace) {
      try {
        const git = await client.gitStatus(workspace.id, 1);
        if (git.repository) {
          await rail.openWorkspace(workspace.id);
          setBusy(false);
          onClose();
          return;
        }
        setStatus({
          tone: "warn",
          text: `“${workspace.name}” was added, but it isn't a Git repository yet. Run git init in its terminal to make it one.`,
        });
      } catch {
        await rail.openWorkspace(workspace.id);
        onClose();
      }
    }
    setBusy(false);
  };
  return (
    <Frame
      title="Add a repository"
      icon={<FolderGit2 />}
      description={<p>Open a Git repository that's already on this computer. Its files stay where they are.</p>}
      onClose={onClose}
    >
      <div className={styles.repoOptions}>
        <button type="button" className={styles.repoOption} onClick={() => void open()} disabled={busy}>
          <FolderGit2 aria-hidden="true" />
          <span>
            <span className={styles.repoTitle}>Open a local repository…</span>
            <span className={styles.repoText}>Choose its folder in the system picker.</span>
          </span>
        </button>
        <div className={styles.repoOption} data-disabled aria-disabled="true">
          <HardDriveDownload aria-hidden="true" />
          <span>
            <span className={styles.repoTitle}>Clone from a URL</span>
            <span className={styles.repoText}>
              Not in this build. Cloning reaches the network, so it waits for the Trust Kernel's network approvals.
            </span>
          </span>
        </div>
      </div>
      {status ? (
        <p className={styles.repoStatus} data-tone={status.tone} role="status">
          {status.text}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        <Button variant="ghost" type="button" onClick={onClose}>
          Close
        </Button>
      </div>
    </Frame>
  );
}

function Confirm({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open) onClose();
  }, [open, onClose]);
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content className={styles.dialog} data-tone="danger">
          <div className={styles.dialogHead}>
            <span className={styles.dialogIcon} data-tone="danger" aria-hidden="true">
              <Trash2 />
            </span>
            <AlertDialog.Title className={styles.dialogTitle}>{title}</AlertDialog.Title>
          </div>
          <AlertDialog.Description asChild>
            <div className={styles.dialogBody}>{body}</div>
          </AlertDialog.Description>
          <div className={styles.dialogActions}>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onConfirm();
                setBusy(false);
                if (ok) setOpen(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function RemoveWorkspace({
  dialog,
  onClose,
}: {
  dialog: Extract<RailDialog, { kind: "remove" }>;
  onClose: () => void;
}) {
  const workspaces = useWorkspaces();
  const { entry } = dialog;
  return (
    <Confirm
      title={`Remove “${entry.name}” from KalCode?`}
      body={
        <>
          <p>
            <strong>Nothing is deleted.</strong> The folder <code>{entry.displayPath}</code> and every file in it stay
            on your disk.
          </p>
          <p>
            KalCode forgets this workspace: it leaves the rail and its terminal tabs close. Its threads keep their
            history. You can add the folder again any time with Open folder.
          </p>
        </>
      }
      confirmLabel="Remove from KalCode"
      onConfirm={async () => {
        const workspace = workspaces.workspaces.find((w) => w.id === entry.workspaceId);
        if (!workspace) return true;
        return workspaces.remove(workspace);
      }}
      onClose={onClose}
    />
  );
}

function DeleteGroup({
  dialog,
  onClose,
}: {
  dialog: Extract<RailDialog, { kind: "delete-group" }>;
  onClose: () => void;
}) {
  const rail = useRail();
  return (
    <Confirm
      title={`Remove the folder “${dialog.group.name}”?`}
      body={<p>Only the rail folder goes away. Its workspaces move to Recent; nothing changes on disk.</p>}
      confirmLabel="Remove folder"
      onConfirm={async () => {
        await rail.deleteGroup(dialog.group);
        return true;
      }}
      onClose={onClose}
    />
  );
}
