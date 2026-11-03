// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { ApiError, errorMessage, deleteResources, type MadeResource, type ResourceRef } from "../api";
import { when } from "../time";
import { ConfirmDialog } from "./ConfirmDialog";
import { DataTable, type DataTableColumn } from "./DataTable";
import { Pill } from "./Pill";

/** Read out, not shown. */
const visuallyHidden = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

/** A resource's name as people know it: its name, else its id. */
export const resourceName = (r: { name: string | null; externalId: string }) => r.name ?? r.externalId;

/** A product's name without its team's prefix: "gcp-project" → "project". */
export const productName = (r: MadeResource) => (r.product.startsWith(`${r.productTeam}-`) ? r.product.slice(r.productTeam.length + 1) : r.product);

/** A resource's state, linking to its delete's run while there is one. `waiting`: its delete waits for an admin. */
export function ResourceState({ resource, waiting = false }: { resource: MadeResource; waiting?: boolean }) {
  const run = (children: ReactNode) =>
    resource.deletingExecutionId ? (
      <Link component={RouterLink} to={`/runs/${resource.deletingExecutionId}`} underline="none">
        {children}
      </Link>
    ) : (
      children
    );
  switch (resource.state) {
    case "deleting":
      return run(<Pill tone="info">Deleting</Pill>);
    case "delete_failed":
      return run(<Pill tone="error">Delete failed</Pill>);
    case "deleted":
      return <Pill tone="neutral">Deleted</Pill>;
    default:
      return waiting ? <Pill tone="warning">Waiting for an admin</Pill> : <Pill tone="success">Made</Pill>;
  }
}

/** What it depends on and what uses it, one line each, when there's any. */
export function ResourceLinks({ resource }: { resource: MadeResource }) {
  const names = (refs: ResourceRef[]) => refs.map(resourceName).join(", ");
  const usedBy = resource.dependents.length + resource.hiddenDependents;
  return (
    <>
      {resource.dependsOn.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
          Uses {names(resource.dependsOn)}
        </Typography>
      )}
      {usedBy > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
          Used by {names(resource.dependents)}
          {resource.hiddenDependents > 0 &&
            `${resource.dependents.length > 0 ? " and " : ""}${String(resource.hiddenDependents)} you can't see`}
        </Typography>
      )}
    </>
  );
}

/**
 * Deleting what runs made: a confirm, then the product's cleanup as one run,
 * which opens. Something others still use isn't deleted on your say: asking
 * sends it to an admin (decision 25), and says so. `ask` takes one or several
 * (one team's); `ui` is the dialog and what happened; `onAsked`, called once
 * an admin has been asked, so a list of those waiting can show it.
 */
export function useResourceDelete(onAsked?: () => void): { ask: (resources: MadeResource[]) => void; ui: ReactNode } {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState<MadeResource[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  async function remove(resources: MadeResource[]): Promise<void> {
    setBusy(true);
    setError(null);
    setAsked(null);
    try {
      navigate(`/runs/${await deleteResources(resources.map((r) => r.id))}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "HAS_DEPENDENTS") {
        setAsked(err.message);
        onAsked?.();
      } else setError(errorMessage(err, "Couldn't delete it."));
      setBusy(false);
      setConfirming(null);
    }
  }

  const one = confirming?.length === 1 ? confirming[0] : null;
  const ids = new Set(confirming?.map((r) => r.id));
  // Used by something outside what's being deleted.
  const inUse = (confirming ?? []).some((r) => r.hiddenDependents > 0 || r.dependents.some((d) => !ids.has(d.id)));
  const title = one ? `Delete ${resourceName(one)}?` : `Delete ${String(confirming?.length ?? 0)}?`;
  const description = inUse
    ? `Other resources still use ${one ? `this ${one.type}` : "some of these"}, so it's deleted only if an admin approves it. Ask them now? (To skip that, delete what uses it first.)`
    : one
      ? `This runs ${one.productTeam}'s cleanup for this ${one.type}, which deletes it where it lives. You'll see the run.`
      : `${listNames(confirming ?? [])}: each one's cleanup runs, in one run, newest first, which deletes them where they live. You'll see the run.`;

  return {
    ask: (resources) => {
      setError(null);
      setAsked(null);
      setConfirming(resources);
    },
    ui: (
      <>
        {error && <Alert severity="error">{error}</Alert>}
        {asked && <Alert severity="info">{asked}</Alert>}
        <ConfirmDialog
          open={confirming !== null}
          title={title}
          description={description}
          confirmLabel={inUse ? "Ask an admin" : "Delete"}
          destructive
          busy={busy}
          onConfirm={() => { if (confirming) void remove(confirming); }}
          onCancel={() => { setConfirming(null); }}
        />
      </>
    ),
  };
}

/** "a, b and c". */
export function listNames(resources: { name: string | null; externalId: string }[]): string {
  const names = resources.map(resourceName);
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** Whether a row can be picked for a delete with others. */
export const selectable = (r: MadeResource, waiting: Set<string>) => r.canDelete && r.state !== "deleting" && r.state !== "deleted" && !waiting.has(r.id);

/**
 * What runs made (ResourceService), with Delete where you may (Try again
 * once a delete failed): it runs the product's cleanup action and opens that
 * run. `showRun` adds the product and the run that made each; `waiting`, the
 * ids whose delete waits for an admin; `selection`, a box on each row to
 * delete several at once.
 */
export function ResourceTable({
  resources,
  showRun = false,
  emptyMessage,
  waiting = new Set<string>(),
  selection,
  userEmail,
  onAsked,
}: {
  resources: MadeResource[] | null;
  showRun?: boolean;
  emptyMessage?: ReactNode;
  waiting?: Set<string>;
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void };
  /** Whose "just you" a resource made for one person is. */
  userEmail?: string;
  /** A delete was sent to an admin (it had dependents). */
  onAsked?: () => void;
}) {
  const remove = useResourceDelete(onAsked);

  const toggle = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };

  const columns: DataTableColumn<MadeResource>[] = [
    ...(selection
      ? [
          {
            key: "select",
            header: <Box component="span" sx={visuallyHidden}>Select</Box>,
            render: (r: MadeResource) => (
              <Checkbox
                checked={selection.selected.has(r.id)}
                disabled={!selectable(r, waiting)}
                onChange={() => { toggle(r.id); }}
                slotProps={{ input: { "aria-label": `Select ${resourceName(r)}` } }}
                sx={{ m: -1 }}
              />
            ),
          } satisfies DataTableColumn<MadeResource>,
        ]
      : []),
    {
      key: "what",
      header: "What",
      render: (r) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
            {r.link ? (
              <Link href={r.link} target="_blank" rel="noopener noreferrer">
                {resourceName(r)} ↗
              </Link>
            ) : (
              resourceName(r)
            )}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono", overflowWrap: "anywhere" }}>
            {r.type}
            {r.name ? ` · ${r.externalId}` : ""}
          </Typography>
          {r.state !== "deleted" && <ResourceLinks resource={r} />}
        </Box>
      ),
    },
    {
      key: "for",
      header: "Made for",
      hideBelow: "md",
      render: (r) => r.ownerTeam ?? (r.ownerEmail && r.ownerEmail === userEmail ? "just you" : (r.ownerEmail ?? "—")),
    },
    ...(showRun ? [{ key: "by", header: "By", hideBelow: "sm", render: (r: MadeResource) => productName(r) } satisfies DataTableColumn<MadeResource>] : []),
    {
      key: "when",
      header: "Made",
      hideBelow: "md",
      render: (r) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, whiteSpace: "nowrap" }}>
          <span>{when(r.firstReportedAt)}</span>
          {showRun && (
            <Link component={RouterLink} to={`/runs/${r.executionId}`} variant="caption">
              its run, step {r.taskId}
            </Link>
          )}
        </Box>
      ),
    },
    { key: "state", header: "State", render: (r) => <ResourceState resource={r} waiting={waiting.has(r.id)} /> },
    {
      key: "delete",
      header: "",
      align: "right",
      render: (r) =>
        r.canDelete &&
        r.state !== "deleting" &&
        r.state !== "deleted" &&
        !waiting.has(r.id) && (
          <Button size="small" color="error" onClick={() => { remove.ask([r]); }}>
            {r.state === "delete_failed" ? "Try again" : "Delete"}
          </Button>
        ),
    },
  ];

  return (
    <Box>
      {remove.ui && <Box sx={{ "& > .MuiAlert-root": { m: 1.5 } }}>{remove.ui}</Box>}
      <DataTable columns={columns} rows={resources} getRowKey={(r) => r.id} emptyMessage={emptyMessage} />
    </Box>
  );
}
