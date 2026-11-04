// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { FailureHelp as Help } from "../../api";

export const RETRY: Record<string, string> = {
  safe: "Yes: its product finds what an earlier attempt made instead of making it twice.",
  unsafe: "With care: its product doesn't say it's safe to run twice. Check what the failed attempt made first.",
};

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}>
      <Typography component="span" sx={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.6px", textTransform: "uppercase", color: "text.secondary" }}>
        {label}
      </Typography>
      <Typography component="div" sx={{ fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </Box>
  );
}

/** What a failure means, what to do, whether retrying is safe, and whom to ask: side by side, stacked on a phone. */
export function FailureHelp({ help }: { help: Help }) {
  const ask = [help.chat, help.contact].filter(Boolean).join(" · ");
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, gap: 2.5 }}>
      {help.means && <Item label="What it means">{help.means}</Item>}
      {help.whatToDo && <Item label="What to do">{help.whatToDo}</Item>}
      {RETRY[help.retry] && (
        <Item label="Safe to retry?">
          <Box component="span" sx={{ color: help.retry === "safe" ? "success.dark" : "warning.dark" }}>
            {RETRY[help.retry]}
          </Box>
        </Item>
      )}
      {(ask || help.url) && (
        <Item label={`Ask ${help.team}`}>
          {ask}
          {help.url && (
            <>
              {ask ? " · " : ""}
              <Link href={help.url} target="_blank" rel="noopener noreferrer">
                Runbooks ↗
              </Link>
            </>
          )}
        </Item>
      )}
    </Box>
  );
}

/** Whose words the explanation is. */
export function explainedBy(help: Help): string {
  return help.fromOwner ? `Explanation written by ${help.team} for this error code.` : "Explanation from Vennir.";
}
