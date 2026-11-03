// SPDX-License-Identifier: MIT
import { type ReactNode } from "react";
import { Box, ButtonBase, Card, Chip, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";

/** The one-line explanation at the top of each tab. */
export function TabIntro({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 760, mb: 3 }}>
      {children}
    </Typography>
  );
}

/** For a label only a screen reader needs (an actions column's header). */
export const visuallyHidden = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" } as const;

/** The small capitals over a group of cards ("Your teams · 2"); danger
 * for the admins' end-of-life section. */
export function SectionLabel({ children, id, tone }: { children: ReactNode; id?: string; tone?: "danger" }) {
  return (
    <Typography
      variant="subtitle2"
      component="h2"
      id={id}
      sx={{
        mb: 1.5,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: tone === "danger" ? "error.main" : "text.secondary",
      }}
    >
      {children}
    </Typography>
  );
}

/** A card's own heading and what it's for, the boards' card header. */
export function CardTitle({ title, children, id, aside }: { title: ReactNode; children?: ReactNode; id?: string; aside?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 1.5, flexWrap: "wrap" }}>
      <Box sx={{ minWidth: 0, flex: "1 1 220px" }}>
        <Typography variant="h6" component="h2" id={id} sx={{ fontSize: 17 }}>
          {title}
        </Typography>
        {children && (
          <Typography variant="body2" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            {children}
          </Typography>
        )}
      </Box>
      {aside}
    </Box>
  );
}

/** One card on a team's Settings: its heading, then what it holds. */
export function SettingsCard({ title, children, tone }: { title: string; children: ReactNode; tone?: "danger" }) {
  return (
    <Card
      component="section"
      aria-label={title}
      sx={{ p: { xs: 2, sm: 2.75 }, display: "flex", flexDirection: "column", gap: 1.5, borderColor: tone === "danger" ? "error.light" : undefined }}
    >
      <Typography variant="h6" component={tone === "danger" ? "h3" : "h2"} sx={{ fontSize: 17 }}>
        {title}
      </Typography>
      {children}
    </Card>
  );
}

/** One part of a bot's card (its CI sign-in, its templates, its tokens):
 * a rule above, a small heading, and the part's own action beside it. */
export function BotPart({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Stack spacing={1.25} sx={{ pt: 2, borderTop: 1, borderColor: "divider" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap", minHeight: 32 }}>
        <Typography variant="subtitle2" component="h4" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {action}
      </Box>
      {children}
    </Stack>
  );
}

export function SectionHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap", mb: 1.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, fontSize: 18 }}>
        {title}
      </Typography>
      {aside}
    </Box>
  );
}

/** A large radio-style option: a title, a description, and a selected
 * state. A real button, so it works with the keyboard. */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  badge,
  disabled = false,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <ButtonBase
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      sx={{
        width: "100%",
        textAlign: "left",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        gap: 1.5,
        p: 2,
        borderRadius: 2,
        border: 1,
        borderColor: selected ? "primary.main" : "divider",
        boxShadow: selected ? (theme) => `inset 0 0 0 1px ${theme.palette.primary.main}` : "none",
        bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.05) : "background.paper",
        opacity: disabled ? 0.55 : 1,
        "&:hover": { borderColor: disabled ? "divider" : "primary.main" },
      }}
    >
      <Box
        sx={{
          width: 18,
          height: 18,
          mt: 0.25,
          borderRadius: "50%",
          flexShrink: 0,
          boxSizing: "border-box",
          border: selected ? "6px solid" : "2px solid",
          borderColor: selected ? "primary.main" : "text.disabled",
        }}
      />
      <Stack spacing={0.5} sx={{ minWidth: 0 }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
          {badge}
        </Box>
        {description && (
          <Typography variant="body2" color="text.secondary" component="div">
            {description}
          </Typography>
        )}
        {children}
      </Stack>
    </ButtonBase>
  );
}

/** Numbered steps across the top of a flow; done steps get a check. */
export function Steps({ labels, current }: { labels: string[]; current: number }) {
  return (
    <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap", mb: 2.5 }}>
      {labels.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <Box key={label} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 700,
                bgcolor: active ? "primary.main" : done ? "success.light" : "action.selected",
                color: active || done ? "common.white" : "text.secondary",
              }}
            >
              {done ? <CheckIcon sx={{ fontSize: 16 }} /> : step}
            </Box>
            <Typography
              variant="body2"
              sx={{ fontWeight: active ? 600 : 400, color: active ? "text.primary" : "text.secondary" }}
            >
              {label}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** A label/value grid for a detail panel. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 1.5, rowGap: 0.5, fontSize: 14 }}>
      {rows.map(([label, value]) => (
        <Box key={label} sx={{ display: "contents" }}>
          <Typography variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography variant="body2" component="div" sx={{ overflowWrap: "anywhere" }}>
            {value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}


export function NotYetTested() {
  return <Chip label="Not yet tested" size="small" variant="outlined" />;
}

/** "3 min ago", "2 h ago", or a date for anything older than a day. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  if (seconds < 86400) return `${String(Math.floor(seconds / 3600))} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** ESO's Go durations ("1h0m0s") as people write them ("1h"). */
export function shortDuration(value: string): string {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
  if (!match) return value;
  const parts = [
    [match[1], "h"],
    [match[2], "m"],
    [match[3], "s"],
  ].filter(([amount]) => amount !== undefined && Number(amount) !== 0);
  return parts.length ? parts.map(([amount, unit]) => `${String(Number(amount))}${unit ?? ""}`).join(" ") : value;
}
