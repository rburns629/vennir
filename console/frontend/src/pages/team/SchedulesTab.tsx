// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { errorMessage, deleteSchedule, listSchedules, updateSchedule, type Schedule } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { when } from "../../time";
import { describeCron, EditScheduleDialog } from "../catalog/ScheduleDialog";
import { TabIntro } from "./shared";

/**
 * The team's schedules: what each runs, when, as which bot, how its last
 * start went. Its maintainers pause, resume, edit and delete them; a schedule is
 * made from a template's or action's run form (Schedule…).
 */
export function SchedulesTab({ teamName, readOnly }: { teamName: string; readOnly: boolean }) {
  const [rows, setRows] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [editing, setEditing] = useState<Schedule | null>(null);

  const load = useCallback(() => {
    listSchedules(teamName)
      .then(setRows)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the schedules.")); });
  }, [teamName]);
  useEffect(load, [load]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    }
  }

  const columns: DataTableColumn<Schedule>[] = [
    {
      key: "name",
      header: "Schedule",
      render: (s) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {s.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {s.kind === "template" ? `${s.runnableName} by ${s.runnableTeam}` : s.runnableName}
          </Typography>
        </Box>
      ),
    },
    {
      key: "when",
      header: "When",
      render: (s) => (
        <Box>
          <Typography variant="body2">{describeCron(s.cron)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {s.timeZone}
            {s.nextRunAt ? ` · next ${when(s.nextRunAt)}` : s.enabled ? " · never again" : " · paused"}
          </Typography>
        </Box>
      ),
    },
    { key: "bot", header: "Runs as", hideBelow: "md", render: (s) => s.botEmail },
    {
      key: "last",
      header: "Last",
      hideBelow: "sm",
      render: (s) =>
        s.lastError ? (
          <Typography variant="caption" color="error">
            {s.lastError}
          </Typography>
        ) : s.lastExecutionId ? (
          <Link component={RouterLink} to={`/runs/${s.lastExecutionId}`} variant="body2">
            {s.lastRunAt ? when(s.lastRunAt) : "its run"}
          </Link>
        ) : (
          "—"
        ),
    },
    {
      key: "on",
      header: "On",
      render: (s) => (
        <Switch
          checked={s.enabled}
          disabled={readOnly}
          slotProps={{ input: { "aria-label": `${s.name} on` } }}
          onChange={(e) => void act(() => updateSchedule(s.id, { enabled: e.target.checked }))}
        />
      ),
    },
    {
      key: "delete",
      header: "",
      align: "right",
      render: (s) =>
        !readOnly && (
          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 0.5 }}>
            <Button size="small" aria-label={`Edit ${s.name}`} onClick={() => { setEditing(s); }}>
              Edit
            </Button>
            <Button size="small" color="error" aria-label={`Delete ${s.name}`} onClick={() => { setDeleting(s); }}>
              Delete
            </Button>
          </Box>
        ),
    },
  ];

  return (
    <Box>
      <TabIntro>
        Runs the team starts on a timetable, each as one of its bots. Make one from a template&apos;s or action&apos;s form in the{" "}
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>{" "}
        (Schedule…).
      </TabIntro>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Card>
        <DataTable columns={columns} rows={rows} getRowKey={(s) => s.id} emptyMessage="No schedules yet." />
      </Card>
      {editing && (
        <EditScheduleDialog
          schedule={editing}
          onClose={() => { setEditing(null); }}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Nothing more starts on it. The runs it started stay."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const s = deleting;
          setDeleting(null);
          if (s) void act(() => deleteSchedule(s.id));
        }}
        onCancel={() => { setDeleting(null); }}
      />
    </Box>
  );
}
